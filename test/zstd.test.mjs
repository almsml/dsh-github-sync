import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeAll, encodeFrame, readSession, rewriteHeader, scanFrames } from '../lib/zstd.js'

const line = (value) => JSON.stringify(value) + '\n'

test('scanFrames 能识别多帧拼接', () => {
  const bytes = Buffer.concat([encodeFrame('a\n'), encodeFrame('b\n'), encodeFrame('c\n')])
  const { frames } = scanFrames(bytes)
  assert.equal(frames.length, 3)
  assert.equal(decodeAll(bytes), 'a\nb\nc\n')
})

test('readSession 返回 header 与事件行数', () => {
  const header = { type: 'session', version: 4, id: 's1', cwd: 'D:\\demo' }
  const bytes = Buffer.concat([
    encodeFrame(line(header)),
    encodeFrame(line({ type: 'user/message', seq: 1 })),
    encodeFrame(line({ type: 'turn/end', seq: 2 })),
  ])
  const info = readSession(bytes)
  assert.equal(info.header.id, 's1')
  assert.equal(info.lines, 3)
})

test('rewriteHeader 只改 header，事件帧字节不变', () => {
  const header = { type: 'session', version: 4, id: 's1', cwd: '<workspace>' }
  const eventFrame = encodeFrame(line({ type: 'user/message', seq: 1, data: { text: '记得保留我' } }))
  const bytes = Buffer.concat([encodeFrame(line(header)), eventFrame])
  const next = rewriteHeader(bytes, (value) => ({ ...value, cwd: 'E:\\另一台设备' }))
  const info = readSession(next)
  assert.equal(info.header.cwd, 'E:\\另一台设备')
  assert.equal(info.header.id, 's1')
  assert.ok(next.subarray(next.length - eventFrame.length).equals(eventFrame))
})
