/**
 * 会话同步：把某个工作区的 DSH 会话日志导出到仓库里（header 里的本机路径换成占位符），
 * 以及把仓库里的会话导入本机（占位符换成本机工作区路径）。
 *
 * 只改写 header 帧、其余事件帧逐字节保留，所以：
 *  - 不需要解析/重建事件，快且不会破坏格式；
 *  - 两台设备同步同一会话时，差异只可能来自 header 与追加的新事件，
 *    用「事件行数更多的那边赢」就能安全合并（会话日志是只追加的）。
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { decodeAll, readSession, rewriteHeader, summarize } from './zstd.js'

/** 导出到仓库时 header 里的工作区占位符。 */
export const WORKSPACE_PLACEHOLDER = '<workspace>'

/**
 * 会话持久化后端用来给工作区建目录的规则（与 DSH 内置实现一致）：
 * 分隔符压成一个 `-`，非安全字符转成 `~XXXX`，两端加 `--`。
 * @param {string} cwd 绝对工作区路径
 */
export function projectKey(cwd) {
  if (!cwd) throw new Error('工作区路径为空')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 本机某个工作区的会话根目录。 */
export function workspaceSessionsDir(sessionsRoot, cwd) {
  return join(sessionsRoot, projectKey(cwd))
}

const SESSION_FILE_RE = /^session(\.v(\d+))?\.jsonl(\.zstd)?$/

function versionOf(name) {
  const m = SESSION_FILE_RE.exec(name)
  if (!m) return -1
  return m[2] === undefined ? 0 : Number(m[2])
}

/** 列出一个会话目录里的日志文件（版本最高的那个）。 */
export function sessionFileIn(dir) {
  let best = null
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const v = versionOf(entry.name)
    if (v < 0) continue
    if (!best || v > best.version) best = { version: v, name: entry.name }
  }
  return best ? join(dir, best.name) : null
}

/**
 * 列出某个工作区的全部本机会话。
 * @returns {Array<{id:string,dirName:string,file:string,size:number,mtimeMs:number}>}
 */
export function listWorkspaceSessions(sessionsRoot, cwd) {
  const root = workspaceSessionsDir(sessionsRoot, cwd)
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const file = sessionFileIn(dir)
    if (!file) continue
    try {
      const stat = statSync(file)
      out.push({ id: entry.name, dirName: entry.name, file, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      /* 读不到就跳过 */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

function atomicWrite(target, data) {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, target)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw error
  }
}

function pickText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

const NOISE_PREFIXES = [
  'Current runtime context',
  '<system-reminder',
  'A skill is a reusable set',
]

function isNoise(text) {
  return NOISE_PREFIXES.some((prefix) => text.startsWith(prefix))
}

function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n…（已截断 ${text.length - max} 字）`
}

/**
 * 把一份会话日志渲染成可读 Markdown（给 GitHub 网页/手机看）。
 * @param {Buffer} buffer
 * @param {{maxChars?: number}} [options]
 */
export function renderTranscript(buffer, options = {}) {
  const maxChars = options.maxChars ?? 8000
  const { header } = readSession(buffer)
  const lines = decodeAll(buffer).split('\n').filter(Boolean)
  const events = []
  for (const line of lines) {
    try {
      events.push(JSON.parse(line))
    } catch {
      /* 跳过坏行 */
    }
  }
  let title = ''
  const sections = []
  let role = ''
  let buf = []
  const pushRole = (next) => {
    if (buf.length > 0) sections.push({ role, text: buf.join('\n\n') })
    role = next
    buf = []
  }
  for (const event of events) {
    if (event.type === 'session/title' && event.data?.title) {
      title = String(event.data.title)
      continue
    }
    if (event.type === 'user/message') {
      if (event.data?.source?.kind && event.data.source.kind !== 'user') continue
      const text = pickText(event.data?.content)
      if (!text || isNoise(text)) continue
      if (role !== '用户') pushRole('用户')
      buf.push(truncate(text, maxChars))
      continue
    }
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content ?? event.data?.content
      const text = pickText(content)
      if (!text) continue
      if (role !== '助手') pushRole('助手')
      buf.push(truncate(text, maxChars))
      continue
    }
    if (event.type === 'tool/call') {
      const name = String(event.data?.name || 'tool')
      let args = ''
      try {
        args = typeof event.data?.arguments === 'string'
          ? event.data.arguments
          : JSON.stringify(event.data?.arguments ?? '')
      } catch {
        args = ''
      }
      args = args.replace(/\s+/g, ' ').trim()
      if (args.length > 160) args = args.slice(0, 160) + '…'
      if (role !== '助手') pushRole('助手')
      buf.push(`> 🔧 \`${name}\` ${args ? args : ''}`)
    }
  }
  if (buf.length > 0) sections.push({ role, text: buf.join('\n\n') })

  if (!title) {
    const first = sections.find((s) => s.role === '用户')
    title = first ? first.text.replace(/\s+/g, ' ').slice(0, 40) : String(header.id || '未命名会话')
  }
  const createdAt = header.createdAt ? new Date(header.createdAt).toISOString() : '未知'
  const body = []
  body.push(`# ${title}`)
  body.push('')
  body.push(`- 会话 ID: \`${header.id}\``)
  body.push(`- 创建时间: ${createdAt}`)
  body.push(`- 事件数: ${events.length}`)
  body.push('')
  body.push('> 本文件由 dsh-github-sync 自动生成，用来在任意设备上直接阅读对话；原会话文件在同级 `sessions/` 目录。')
  body.push('')
  for (const section of sections) {
    if (!section.text) continue
    body.push(`## ${section.role || '对话'}`)
    body.push('')
    body.push(section.text)
    body.push('')
  }
  return { id: String(header.id || ''), title, markdown: body.join('\n') + '\n' }
}

function writeRepoReadme(outDir, workspace) {
  const name = basename(workspace.replace(/[/\\]+$/, '')) || workspace
  const text = `# 对话与工作区同步目录

这个目录由 **dsh-github-sync** 自动维护，请勿手改（下一轮同步会被覆盖）。

- \`sessions/\` —— DSH 原会话日志（zstd 拼接帧）。header 里的本机工作区路径已替换成 \`${WORKSPACE_PLACEHOLDER}\`，
  换设备后由插件改写成那台机器上的真实路径，因此可以直接接着聊。
- \`transcripts/\` —— 同一批对话的可读 Markdown，手机/网页上不用装 DSH 也能看。
- \`index.md\` —— 会话清单。

工作区：\`${name}\`
`
  atomicWrite(join(outDir, 'README.md'), text)
}

function writeIndex(outDir, rows) {
  const lines = ['# 对话清单', '', '| 会话 | 更新时间 | 事件数 | 记录 |', '| --- | --- | --- | --- |']
  for (const row of rows) {
    const label = (row.title || row.id).replace(/\|/g, '\\|').slice(0, 60)
    const when = row.updatedAt ? new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16) : ''
    lines.push(`| ${label} | ${when} | ${row.lines} | [Markdown](./transcripts/${row.id}.md) |`)
  }
  lines.push('')
  atomicWrite(join(outDir, 'index.md'), lines.join('\n'))
}

/**
 * 把工作区的会话导出到仓库目录。
 * @param {object} options
 * @param {string} options.workspace 工作区绝对路径
 * @param {string} options.sessionsRoot DSH 会话根目录
 * @param {string} options.outDir 仓库里的 .dsh-sync 目录
 * @param {number} [options.maxSessionBytes] 单个会话上限
 * @param {boolean} [options.writeTranscripts]
 * @param {Record<string, {size:number,mtimeMs:number,lines:number,title?:string,file?:string}>} [options.cache]
 *        上次导出缓存（id → 文件元数据）。命中时跳过重写，减少无意义的提交。
 * @returns {{exported:Array<object>, skipped:Array<object>, unchanged:number, bytes:number, cache:object, rows:Array<object>}}
 */
export function exportWorkspaceSessions(options) {
  const {
    workspace, sessionsRoot, outDir,
    maxSessionBytes = 8 * 1024 * 1024,
    writeTranscripts = true,
    cache = {},
  } = options
  const sessions = listWorkspaceSessions(sessionsRoot, workspace)
  const nextCache = {}
  const exported = []
  const skipped = []
  const rows = []
  let bytes = 0

  mkdirSync(join(outDir, 'sessions'), { recursive: true })
  if (writeTranscripts) mkdirSync(join(outDir, 'transcripts'), { recursive: true })
  writeRepoReadme(outDir, workspace)

  for (const item of sessions) {
    const cached = cache[item.id]
    const unchanged = cached && cached.size === item.size && cached.mtimeMs === item.mtimeMs && cached.file === item.file
    let info
    try {
      if (item.size > maxSessionBytes) {
        skipped.push({ id: item.id, reason: `超过 ${Math.round(maxSessionBytes / 1024 / 1024)}MB 上限`, size: item.size })
        continue
      }
      const raw = readFileSync(item.file)
      info = summarize(raw)
      const exportedFile = join(outDir, 'sessions', item.dirName, item.file === null ? '' : basename(item.file))
      if (unchanged && existsSync(exportedFile)) {
        nextCache[item.id] = cached
        rows.push({ id: item.id, title: cached.title || item.id, lines: cached.lines, updatedAt: item.mtimeMs })
        continue
      }
      const portable = rewriteHeader(raw, (header) => ({ ...header, cwd: WORKSPACE_PLACEHOLDER }))
      atomicWrite(exportedFile, portable)
      let title = item.id
      if (writeTranscripts) {
        const transcript = renderTranscript(raw)
        title = transcript.title || item.id
        atomicWrite(join(outDir, 'transcripts', `${item.id}.md`), transcript.markdown)
      }
      nextCache[item.id] = {
        size: item.size,
        mtimeMs: item.mtimeMs,
        lines: info.lines,
        title,
        file: item.file,
      }
      bytes += portable.length
      exported.push({ id: item.id, title, lines: info.lines, size: item.size })
      rows.push({ id: item.id, title, lines: info.lines, updatedAt: item.mtimeMs })
    } catch (error) {
      skipped.push({ id: item.id, reason: error instanceof Error ? error.message : String(error), size: item.size })
    }
  }

  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  writeIndex(outDir, rows)
  return { exported, skipped, unchanged: sessions.length - exported.length - skipped.length, bytes, cache: nextCache, rows }
}

/**
 * 把仓库里导出的会话导入本机。
 * @param {object} options
 * @param {string} options.workspace 本机工作区绝对路径
 * @param {string} options.sessionsRoot 本机会话根目录
 * @param {string} options.fromDir 仓库里的 .dsh-sync 目录
 * @param {Set<string>} [options.liveSessions] 本进程里还开着的会话 id，不覆盖
 * @param {number} [options.maxSessionBytes]
 * @returns {{imported:Array<object>, skipped:Array<object>, missing:number}}
 */
export function importWorkspaceSessions(options) {
  const {
    workspace, sessionsRoot, fromDir,
    liveSessions = new Set(),
    maxSessionBytes = 8 * 1024 * 1024,
  } = options
  const sourceRoot = join(fromDir, 'sessions')
  const imported = []
  const skipped = []
  if (!existsSync(sourceRoot)) return { imported, skipped, missing: 1 }

  const targetRoot = workspaceSessionsDir(sessionsRoot, workspace)
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(sourceRoot, entry.name)
    const file = sessionFileIn(dir)
    if (!file) continue
    const id = entry.name
    if (liveSessions.has(id)) {
      skipped.push({ id, reason: '本机正在使用该会话，跳过覆盖' })
      continue
    }
    try {
      const stat = statSync(file)
      if (stat.size > maxSessionBytes) {
        skipped.push({ id, reason: '超过单会话大小上限' })
        continue
      }
      const remote = readFileSync(file)
      const remoteInfo = readSession(remote)
      const targetDir = join(targetRoot, entry.name)
      const targetFile = join(targetDir, basename(file))
      const localLines = existsSync(targetFile) ? readSession(readFileSync(targetFile)).lines : -1
      if (remoteInfo.lines <= localLines) {
        skipped.push({ id, reason: '本机版本不旧' })
        continue
      }
      const local = rewriteHeader(remote, (header) => ({ ...header, cwd: workspace }))
      atomicWrite(targetFile, local)
      imported.push({ id, lines: remoteInfo.lines, replaced: localLines >= 0 })
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { imported, skipped, missing: 0 }
}

/** 复制一个会话文件（测试/备份用）。 */
export function copySession(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}
