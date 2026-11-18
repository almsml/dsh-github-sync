import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFrame } from '../lib/zstd.js'
import { readSession } from '../lib/zstd.js'
import { workspaceSessionsDir } from '../lib/sessions.js'
import { writeConfig } from '../lib/config.js'
import { createSyncEngine } from '../lib/sync.js'

const line = (value) => JSON.stringify(value) + '\n'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makeSessionFile(sessionsRoot, workspace, id, extra = 0) {
  const dir = join(workspaceSessionsDir(sessionsRoot, workspace), id)
  mkdirSync(dir, { recursive: true })
  const frames = [
    encodeFrame(line({
      type: 'session', version: 4, id, createdAt: 1700000000000,
      cwd: workspace, isSeeded: false, delegationDepth: 0,
    })),
    encodeFrame(line({ type: 'session/title', seq: 1, time: 1, data: { title: '跨设备测试' } })),
    encodeFrame(line({
      type: 'user/message', seq: 2, time: 2,
      data: { content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } },
    })),
    encodeFrame(line({
      type: 'assistant/message', seq: 3, time: 3,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '第二句' }] } },
    })),
    encodeFrame(line({ type: 'turn/end', seq: 4, time: 4, data: { turn: 1 } })),
  ]
  for (let i = 0; i < extra; i++) {
    frames.push(encodeFrame(line({ type: 'turn/end', seq: 5 + i, time: 5 + i, data: { turn: 2 + i } })))
  }
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat(frames))
  return file
}

test('两台设备通过同一个远端同步代码与对话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-github-sync-e2e-'))
  const remote = join(root, 'remote.git')
  mkdirSync(remote, { recursive: true })
  git(remote, 'init', '--bare')
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')

  // ---- 设备 A ----
  process.env.DSH_HOME = join(root, 'homeA')
  const workspaceA = join(root, 'workA')
  const sessionsRootA = join(root, 'homeA', 'sessions')
  mkdirSync(workspaceA, { recursive: true })
  writeFileSync(join(workspaceA, 'hello.txt'), 'hello from A\n')
  writeFileSync(join(workspaceA, 'secret.env'), 'SHOULD_NOT_UPLOAD=1\n')
  makeSessionFile(sessionsRootA, workspaceA, 'sess-shared')

  writeConfig({
    workspace: workspaceA,
    repo: remote,
    branch: 'main',
    token: '',
    syncSessions: true,
    writeTranscripts: true,
    debounceMs: 1000,
    pullOnStart: false,
  })
  const engineA = createSyncEngine({ logger: { info() {}, warn() {}, error() {} } })
  const first = await engineA.syncNow({ reason: 'test' })
  assert.equal(first.ok, true, first.message)

  assert.ok(existsSync(join(workspaceA, '.dsh-sync', 'sessions', 'sess-shared', 'session.v4.jsonl.zstd')))
  assert.ok(existsSync(join(workspaceA, '.dsh-sync', 'transcripts', 'sess-shared.md')))
  const md = readFileSync(join(workspaceA, '.dsh-sync', 'transcripts', 'sess-shared.md'), 'utf8')
  assert.match(md, /跨设备测试/)

  const exported = readSession(readFileSync(join(workspaceA, '.dsh-sync', 'sessions', 'sess-shared', 'session.v4.jsonl.zstd')))
  assert.equal(exported.header.cwd, '<workspace>')

  const logA = git(remote, 'log', '--oneline')
  assert.match(logA, /chore\(sync\)/)
  // 默认排除项生效：密钥文件与大目录不会进仓库
  const tracked = git(remote, 'ls-tree', '-r', '--name-only', 'main')
  assert.ok(tracked.includes('hello.txt'))
  assert.ok(!tracked.includes('secret.env'))
  assert.ok(tracked.includes('.dsh-sync/sessions/sess-shared/session.v4.jsonl.zstd'))

  // ---- 设备 B：克隆远端后拉取会话 ----
  process.env.DSH_HOME = join(root, 'homeB')
  const workspaceB = join(root, 'workB')
  git(root, 'clone', remote, workspaceB)
  const sessionsRootB = join(root, 'homeB', 'sessions')
  writeConfig({
    workspace: workspaceB,
    repo: remote,
    branch: 'main',
    token: '',
    syncSessions: true,
    writeTranscripts: true,
    debounceMs: 1000,
    pullOnStart: false,
  })
  const engineB = createSyncEngine({ logger: { info() {}, warn() {}, error() {} } })
  const second = await engineB.syncNow({ reason: 'test' })
  assert.equal(second.ok, true, second.message)

  const importedB = join(workspaceSessionsDir(sessionsRootB, workspaceB), 'sess-shared', 'session.v4.jsonl.zstd')
  assert.ok(existsSync(importedB), 'B 应该导入 A 的会话')
  const bSession = readSession(readFileSync(importedB))
  assert.equal(bSession.header.cwd, workspaceB)
  assert.equal(bSession.lines, 5)

  // ---- B 接着聊，追加事件并推送 ----
  writeFileSync(importedB, Buffer.concat([
    readFileSync(importedB),
    encodeFrame(line({ type: 'turn/end', seq: 5, time: 100, data: { turn: 2 } })),
  ]))
  writeFileSync(join(workspaceB, 'hello.txt'), 'hello from B\n')
  const third = await engineB.syncNow({ reason: 'test' })
  assert.equal(third.ok, true, third.message)
  assert.equal(third.pushed, true)

  // ---- 设备 A 拉取，拿到 B 的新事件 ----
  process.env.DSH_HOME = join(root, 'homeA')
  const fourth = await engineA.syncNow({ reason: 'test' })
  assert.equal(fourth.ok, true, fourth.message)
  const aSessionFile = join(workspaceSessionsDir(sessionsRootA, workspaceA), 'sess-shared', 'session.v4.jsonl.zstd')
  const aSession = readSession(readFileSync(aSessionFile))
  assert.equal(aSession.header.cwd, workspaceA, 'A 的会话 header 必须改回本机路径')
  assert.equal(aSession.lines, 6, 'A 应该拿到 B 追加的事件')
  assert.equal(readFileSync(join(workspaceA, 'hello.txt'), 'utf8').trim(), 'hello from B')

  engineA.dispose()
  engineB.dispose()
})

test('空仓库第一次推送、重复同步不产生空提交', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-github-sync-e2e-'))
  const remote = join(root, 'remote.git')
  mkdirSync(remote, { recursive: true })
  git(remote, 'init', '--bare')

  process.env.DSH_HOME = join(root, 'home')
  const workspace = join(root, 'work')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'a.txt'), 'a\n')
  writeConfig({
    workspace,
    repo: remote,
    branch: 'main',
    syncSessions: false,
    pullOnStart: false,
  })
  const engine = createSyncEngine({ logger: { info() {}, warn() {}, error() {} } })
  const first = await engine.syncNow({ reason: '第一次' })
  assert.equal(first.ok, true, first.message)
  const second = await engine.syncNow({ reason: '第二次' })
  assert.equal(second.ok, true, second.message)
  assert.equal(second.steps.includes('远端已是最新') || second.message.includes('没有变化'), true)
  const count = git(remote, 'rev-list', '--count', 'main').trim()
  assert.equal(count, '1')
  engine.dispose()
})
