/**
 * DSH 会话日志是「一个 header 帧 + 每个写入批次一个帧」的标准 zstd 拼接容器。
 * Node 的 zstdDecompressSync / createZstdDecompress 只解第一帧，所以这里自己做
 * 帧边界扫描：不依赖解压即可从 block header 算出每帧结束位置，再逐帧解。
 *
 * 这套帧扫描规则与 @deepseek-ai/dsh-session-persistence-jsonl 的 scanZstdFrames
 * 保持一致（同一份格式约定），以便读写都能被 DSH 原生读取。
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/**
 * 扫描完整帧边界。
 * @param {Buffer} buffer 会话文件全部字节
 * @returns {{frames: Array<{start:number,end:number}>, tornStart?: number}}
 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`不是有效的 zstd 会话日志：偏移 ${offset} 处帧魔数错误`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`会话日志损坏：偏移 ${offset - 1} 处保留了帧头位`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remaining) return { frames, tornStart: start }
    offset += remaining
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`会话日志损坏：偏移 ${offset - 3} 处块类型保留`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 压缩一个带校验和的独立帧。 */
export function encodeFrame(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8')
  return zstdCompressSync(bytes, CHECKSUM_OPTIONS)
}

/** 解压一个完整帧并校验。 */
export function decodeFrame(frame) {
  return zstdDecompressSync(frame)
}

/** 解出会话日志的全部文本（每行一个 JSON 事件）。 */
export function decodeAll(buffer) {
  const { frames } = scanFrames(buffer)
  const parts = []
  for (const frame of frames) {
    parts.push(decodeFrame(buffer.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 读出 header（第一帧里的第一行），并保留其余帧字节原样。
 * @param {Buffer} buffer 完整会话文件
 * @returns {{header: object, rest: Buffer, frames: number, lines: number}}
 */
export function readSession(buffer) {
  const { frames } = scanFrames(buffer)
  if (frames.length === 0) throw new Error('会话日志没有完整帧')
  const first = decodeFrame(buffer.subarray(frames[0].start, frames[0].end))
  const text = first.toString('utf8')
  const newline = text.indexOf('\n')
  const headerLine = newline === -1 ? text : text.slice(0, newline)
  let header
  try {
    header = JSON.parse(headerLine)
  } catch {
    throw new Error('会话 header 不是合法 JSON')
  }
  if (header?.type !== 'session') throw new Error('会话 header 类型不是 session')
  const rest = buffer.subarray(frames[0].end)
  const lines = text.split('\n').filter(Boolean).length + countLines(rest)
  return { header, rest, frames: frames.length, lines }
}

function countLines(rest) {
  if (rest.length === 0) return 0
  let n = 0
  // 逐帧解出再数，避免把拼接后的整段复制一份
  for (const frame of scanFrames(rest).frames) {
    const text = decodeFrame(rest.subarray(frame.start, frame.end)).toString('utf8')
    n += text.split('\n').filter(Boolean).length
  }
  return n
}

/**
 * 只替换 header 里的工作区路径，事件帧一个字节都不动。
 * DSH 自己写日志时就是「header 帧 + 追加帧」，所以这样生成的产物仍可被原生读取，
 * 同时跨设备来回同步时只有 header 会按设备改写。
 * @param {Buffer} buffer 原会话文件
 * @param {(header: object) => object} rewrite 改写函数
 * @returns {Buffer}
 */
export function rewriteHeader(buffer, rewrite) {
  const { header, rest } = readSession(buffer)
  const next = rewrite({ ...header })
  const line = JSON.stringify(next) + '\n'
  return Buffer.concat([encodeFrame(line), rest])
}

/** 会话事件条数（用于判断哪边更新）。 */
export function countEvents(buffer) {
  return readSession(buffer).lines
}

/** 会话的稳定摘要，用于本地状态缓存。 */
export function summarize(buffer) {
  const info = readSession(buffer)
  return {
    id: String(info.header.id || ''),
    lines: info.lines,
    frames: info.frames,
    header: info.header,
  }
}
