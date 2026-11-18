import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFrame } from '../lib/zstd.js'
import {
  exportWorkspaceSessions, importWorkspaceSessions, projectKey, renderTranscript,
  workspaceSessionsDir,
} from '../lib/sessions.js'
import { readSession } from '../lib/zstd.js'

const line = (value) => JSON.stringify(value) + '\n'

function makeSession(workspace, id) {
  return Buffer.concat([
    encodeFrame(line({
      type: 'session', version: 4, id, createdAt: 1700000000000,
      cwd: workspace, isSeeded: false, delegationDepth: 0,
    })),
    encodeFrame(line({
      type: 'session/title', seq: 1, time: 1,
      data: { title: '测试对话' },
    })),
    encodeFrame(line({
      type: 'user/message', seq: 2, time: 2,
      data: { content: [{ type: 'text', text: '你好，帮我看下这个项目' }], source: { kind: 'user' }, role: 'user' },
    })),
    encodeFrame(line({
      type: 'assistant/message', seq: 3, time: 3,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，我来看看。' }] } },
    })),
    encodeFrame(line({ type: 'tool/call', seq: 4, time: 4, data: { name: 'read', arguments: '{"path":"a.txt"}' } })),
    encodeFrame(line({ type: 'turn/end', seq: 5, time: 5, data: { turn: 1 } })),
  ])
}

test('projectKey 与 DSH 的目录命名一致', () => {
  assert.equal(projectKey('D:\\新建文件夹 (2)'), '--D-~65B0~5EFA~6587~4EF6~5939~0020~00282~0029--')
  assert.equal(projectKey('C:\\Users\\A\\.dsh\\profiles\\desktop'), '--C-Users-A-.dsh-profiles-desktop--')
})

test('导出把本机路径换成占位符，并生成可读记录', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sync-home-'))
  const workspace = join(home, 'project')
  mkdirSync(workspace, { recursive: true })
  const sessionsRoot = join(home, 'sessions')
  const sessionDir = join(workspaceSessionsDir(sessionsRoot, workspace), 'sess-1')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), makeSession(workspace, 'sess-1'))

  const outDir = join(workspace, '.dsh-sync')
  const result = exportWorkspaceSessions({ workspace, sessionsRoot, outDir, writeTranscripts: true })
  assert.equal(result.exported.length, 1)
  const exported = readSession(
    readFileSync(join(outDir, 'sessions', 'sess-1', 'session.v4.jsonl.zstd')),
  )
  assert.equal(exported.header.cwd, '<workspace>')
  assert.equal(exported.lines, 6)
  const md = readFileSync(join(outDir, 'transcripts', 'sess-1.md'), 'utf8')
  assert.match(md, /测试对话/)
  assert.match(md, /你好，帮我看下这个项目/)
  assert.match(md, /好的，我来看看/)
  assert.match(md, /read/)
})

test('导入把占位符换成本机路径，且不覆盖更新的本地版本', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sync-home-'))
  const workspace = join(home, 'target')
  mkdirSync(workspace, { recursive: true })
  const sessionsRoot = join(home, 'sessions')
  const outDir = join(home, 'repo', '.dsh-sync')
  const remoteDir = join(outDir, 'sessions', 'sess-9')
  mkdirSync(remoteDir, { recursive: true })
  writeFileSync(join(remoteDir, 'session.v4.jsonl.zstd'), makeSession('<workspace>', 'sess-9'))

  const first = importWorkspaceSessions({ workspace, sessionsRoot, fromDir: outDir })
  assert.equal(first.imported.length, 1)
  const localFile = join(workspaceSessionsDir(sessionsRoot, workspace), 'sess-9', 'session.v4.jsonl.zstd')
  const local = readSession(readFileSync(localFile))
  assert.equal(local.header.cwd, workspace)

  // 本机再追加一条事件后，远端旧版本不应覆盖
  writeFileSync(localFile, Buffer.concat([readFileSync(localFile), encodeFrame(line({ type: 'turn/end', seq: 6, time: 6, data: {} }))]))
  const second = importWorkspaceSessions({ workspace, sessionsRoot, fromDir: outDir })
  assert.equal(second.imported.length, 0)
  assert.equal(readSession(readFileSync(localFile)).lines, 7)
})

test('renderTranscript 跳过系统提示噪音', () => {
  const header = { type: 'session', version: 4, id: 'x', createdAt: 1, cwd: 'D:\\x' }
  const bytes = Buffer.concat([
    encodeFrame(line(header)),
    encodeFrame(line({
      type: 'user/message', seq: 1,
      data: { content: [{ type: 'text', text: 'Current runtime context. stuff' }], source: { kind: 'user' } },
    })),
    encodeFrame(line({
      type: 'user/message', seq: 2,
      data: { content: [{ type: 'text', text: '真正的话' }], source: { kind: 'user' } },
    })),
  ])
  const md = renderTranscript(bytes).markdown
  assert.ok(!md.includes('Current runtime context'))
  assert.ok(md.includes('真正的话'))
})
