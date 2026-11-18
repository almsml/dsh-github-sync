/**
 * 同步引擎：git 提交/拉取/推送 + 会话导入导出。
 * 所有操作串行执行；同一工作区跨进程用锁文件互斥。
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runGit, git, gitOrNull, isRepo, repoRoot, setGitProxy } from './git.js'
import {
  authUrl, displayRepo, isConfigured, readConfig, readState, redact, SECRET_EXCLUDES,
  stateDir, updateState, workspaceKey,
} from './config.js'
import { exportWorkspaceSessions, importWorkspaceSessions } from './sessions.js'

const MARK_START = '# >>> dsh-github-sync >>>'
const MARK_END = '# <<< dsh-github-sync <<<'

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireLock(key) {
  mkdirSync(stateDir(), { recursive: true })
  const file = join(stateDir(), `sync-${key}.lock`)
  const take = () => {
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
    return () => {
      try {
        unlinkSync(file)
      } catch {
        /* ignore */
      }
    }
  }
  try {
    return take()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let info = null
    try {
      info = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      /* 坏锁当过期处理 */
    }
    const stale = !info || Date.now() - Number(info.at || 0) > 10 * 60 * 1000 || !pidAlive(info.pid)
    if (!stale) throw new Error('另一个 DSH 实例正在同步这个工作区，稍后再试')
    try {
      unlinkSync(file)
    } catch {
      /* ignore */
    }
    return take()
  }
}

function samePath(a, b) {
  if (!a || !b) return false
  const norm = (p) => resolve(p).replace(/[/\\]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function readStateFor(workspace) {
  return readState(workspace).state
}

export function createSyncEngine(options = {}) {
  const log = options.logger || {
    info: (...args) => console.log('[github-sync]', ...args),
    warn: (...args) => console.warn('[github-sync]', ...args),
    error: (...args) => console.error('[github-sync]', ...args),
  }
  const liveSessions = new Set()
  let timer = null
  let running = false
  let pendingReason = null
  let disposed = false
  let lastResult = null

  function noteLive(sessionId) {
    if (sessionId) liveSessions.add(sessionId)
  }

  function forgetLive(sessionId) {
    if (sessionId) liveSessions.delete(sessionId)
  }

  async function writeExcludes(root, config, extra = []) {
    const file = join(root, '.git', 'info', 'exclude')
    mkdirSync(dirname(file), { recursive: true })
    let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const start = text.indexOf(MARK_START)
    const end = text.indexOf(MARK_END)
    if (start !== -1 && end > start) text = text.slice(0, start) + text.slice(end + MARK_END.length)
    else if (start !== -1) text = text.slice(0, start)
    const patterns = [...(config.excludePatterns || [])]
    if (config.excludeSecrets) patterns.push(...SECRET_EXCLUDES)
    for (const item of extra) patterns.push(item)
    const block = [MARK_START, ...patterns, MARK_END].join('\n')
    const next = `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${block}\n`
    writeFileSync(file, next)
    return file
  }

  async function ensureRepo(config) {
    const workspace = resolve(config.workspace)
    if (!existsSync(workspace)) throw new Error(`工作区不存在：${workspace}`)
    if (!statSync(workspace).isDirectory()) throw new Error(`工作区不是目录：${workspace}`)

    let root = workspace
    if (!(await isRepo(workspace))) {
      await git(['init'], { cwd: workspace, timeoutMs: 60000 })
      await git(['symbolic-ref', 'HEAD', `refs/heads/${config.branch}`], { cwd: workspace, timeoutMs: 15000 })
      log.info(`已初始化 git 仓库：${workspace}`)
    } else {
      const top = await repoRoot(workspace)
      if (top && !samePath(top, workspace)) {
        root = top
        log.warn(`工作区位于已有仓库 ${top} 内，将按仓库根目录同步`)
      }
    }

    const email = (await gitOrNull(['config', 'user.email'], { cwd: root })) || ''
    if (!email.trim()) {
      await git(['config', 'user.email', 'dsh-github-sync@users.noreply.github.com'], { cwd: root })
      await git(['config', 'user.name', 'DSH GitHub Sync'], { cwd: root })
    }

    const cleanUrl = config.repo
    const origin = (await gitOrNull(['remote', 'get-url', 'origin'], { cwd: root })) || ''
    if (!origin.trim()) {
      await git(['remote', 'add', 'origin', cleanUrl], { cwd: root })
    } else if (!origin.includes('github.com') && !samePath(origin, cleanUrl) && origin !== cleanUrl) {
      log.warn(`origin 已指向 ${displayRepo(origin)}，同步仍按配置的 ${displayRepo(cleanUrl)} 推送，不改动你的 origin`)
    }

    return root
  }

  async function scanLargeFiles(root, maxBytes) {
    const found = []
    const result = await runGit(['status', '--porcelain', '-z', '--untracked-files=all'], {
      cwd: root, timeoutMs: 120000,
    })
    if (result.code !== 0) return found
    const parts = result.stdout.split('\0')
    for (const entry of parts) {
      if (!entry || entry.length < 4) continue
      if (entry.slice(0, 2) !== '??') continue
      const path = entry.slice(3)
      try {
        const stat = statSync(join(root, path))
        if (stat.size > maxBytes) found.push({ path, size: stat.size })
      } catch {
        /* 已消失 */
      }
    }
    return found
  }

  async function applyExcludes(root, config) {
    // 先写基础排除（node_modules 等），这样大文件扫描不用遍历整个依赖树
    await writeExcludes(root, config)
    const large = await scanLargeFiles(root, config.maxFileMB * 1024 * 1024)
    await writeExcludes(root, config, large.map((item) => `/${item.path.replace(/\\/g, '/')}`))
    return large
  }

  async function commitAll(root, reason, token) {
    await git(['add', '-A', '.'], { cwd: root, token, timeoutMs: 300000 })
    const diff = await runGit(['diff', '--cached', '--quiet'], { cwd: root, token })
    if (diff.code === 0) return null
    const message = `chore(sync): ${reason} · ${stamp()}`
    await git(['commit', '--no-verify', '-m', message], { cwd: root, token, timeoutMs: 180000 })
    const sha = (await gitOrNull(['rev-parse', '--short', 'HEAD'], { cwd: root })) || ''
    return { sha, message }
  }

  async function fetchRemote(root, config, token) {
    const url = authUrl(config.repo, token)
    const result = await runGit(['fetch', '--no-tags', url, `refs/heads/${config.branch}`], {
      cwd: root, token, timeoutMs: 180000,
    })
    if (result.code === 0) {
      const commit = await gitOrNull(['rev-parse', '--verify', 'FETCH_HEAD'], { cwd: root })
      return { ok: true, commit }
    }
    const text = `${result.stderr}\n${result.stdout}`
    if (/couldn't find remote ref|not our ref|remote ref does not exist|no such remote ref/i.test(text)) {
      return { ok: false, empty: true, commit: null }
    }
    throw new Error(redact(`拉取失败：${text.trim() || `退出码 ${result.code}`}`, token))
  }

  async function pushRemote(root, config, token) {
    const url = authUrl(config.repo, token)
    const args = ['push', url, `HEAD:refs/heads/${config.branch}`]
    let result = await runGit(args, { cwd: root, token, timeoutMs: 180000 })
    if (result.code === 0) return { ok: true }
    const text = `${result.stderr}\n${result.stdout}`
    if (/non-fast-forward|fetch first|rejected/i.test(text)) {
      log.warn('推送被拒（远端有新提交），先 rebase 再重试一次')
      const fetched = await fetchRemote(root, config, token)
      if (fetched.ok) {
        const rebase = await runGit(['rebase', 'FETCH_HEAD'], { cwd: root, token, timeoutMs: 180000 })
        if (rebase.code !== 0) {
          await runGit(['rebase', '--abort'], { cwd: root, token })
          throw new Error('推送前 rebase 冲突，已回滚。请手动解决冲突后再同步。')
        }
      }
      result = await runGit(args, { cwd: root, token, timeoutMs: 180000 })
      if (result.code === 0) return { ok: true }
    }
    throw new Error(redact(`推送失败：${text.trim() || `退出码 ${result.code}`}`, token))
  }

  async function testConnection() {
    const config = readConfig()
    if (!config.repo) return { ok: false, message: '还没填仓库地址' }
    setGitProxy(config.proxy)
    const token = config.token || process.env.GITHUB_TOKEN || ''
    const url = authUrl(config.repo, token)
    const result = await runGit(['ls-remote', '--heads', url, `refs/heads/${config.branch}`], {
      token, timeoutMs: 60000,
    })
    if (result.code !== 0) {
      return {
        ok: false,
        message: redact(`连不上仓库或没有权限：${(result.stderr || result.stdout).trim()}`, token),
      }
    }
    const line = result.stdout.trim().split('\n').filter(Boolean)[0]
    if (!line) {
      return { ok: true, message: `仓库可访问，但还没有 ${config.branch} 分支（首次推送会创建）` }
    }
    return { ok: true, message: `仓库可访问，${config.branch} 分支最新提交 ${line.slice(0, 8)}` }
  }

  async function status() {
    const config = readConfig()
    const state = config.workspace ? readStateFor(config.workspace) : {}
    const info = {
      configured: isConfigured(config),
      enabled: config.enabled,
      workspace: config.workspace,
      repo: config.repo ? displayRepo(config.repo) : '',
      branch: config.branch,
      hasToken: Boolean(config.token),
      autoPush: config.autoPush,
      syncSessions: config.syncSessions,
      running,
      lastResult: lastResult || null,
      state,
      git: null,
      sessions: null,
    }
    if (config.workspace && existsSync(config.workspace) && (await isRepo(config.workspace))) {
      const root = (await repoRoot(config.workspace)) || config.workspace
      const statusText = (await gitOrNull(['status', '--porcelain'], { cwd: root, timeoutMs: 30000 })) || ''
      const changes = statusText.split('\n').filter(Boolean)
      const head = (await gitOrNull(['log', '-1', '--format=%h %s'], { cwd: root, timeoutMs: 15000 })) || ''
      info.git = {
        root,
        changes: changes.length,
        sample: changes.slice(0, 8),
        head,
        branch: (await gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })) || '',
      }
      const sessionDir = join(root, '.dsh-sync', 'sessions')
      if (existsSync(sessionDir)) {
        try {
          info.sessions = { exported: readdirSync(sessionDir).length }
        } catch {
          /* ignore */
        }
      }
    }
    return info
  }

  async function syncNow(opts = {}) {
    const reason = opts.reason || 'manual'
    const config = readConfig()
    if (disposed) return { ok: false, message: '插件已卸载' }
    if (!config.enabled) return { ok: false, message: '自动同步已在设置里关闭' }
    if (!isConfigured(config)) return { ok: false, message: '还没配置：先在工作区里执行 /github-sync init，再填仓库与 token' }
    if (running) {
      pendingReason = reason
      return { ok: false, message: '正在同步中，稍后会自动再跑一次' }
    }
    running = true
    setGitProxy(config.proxy)
    const token = config.token || process.env.GITHUB_TOKEN || ''
    let release = null
    const startedAt = Date.now()
    try {
      release = acquireLock(workspaceKey(config.workspace))
      const steps = []
      const root = await ensureRepo(config)
      if (!samePath(root, config.workspace)) {
        steps.push(`按仓库根目录同步：${root}`)
      }
      const large = await applyExcludes(root, config)
      if (large.length > 0) {
        steps.push(`排除 ${large.length} 个超过 ${config.maxFileMB}MB 的文件`)
      }

      // 1. 先对齐远端，避免把本地历史推成无关分支
      let remote = { ok: false, empty: true, commit: null }
      if (opts.pull !== false) {
        remote = await fetchRemote(root, config, token)
        if (remote.ok) {
          const hasHead = (await gitOrNull(['rev-parse', '--verify', 'HEAD'], { cwd: root })) !== null
          if (!hasHead) {
            await git(['reset', '--mixed', 'FETCH_HEAD'], { cwd: root, token })
            steps.push('空仓库：已对齐远端历史（保留本地文件）')
          } else {
            const base = await runGit(['merge-base', 'HEAD', 'FETCH_HEAD'], { cwd: root, token })
            if (base.code !== 0) {
              throw new Error('本地仓库与远端历史无关（可能是另一个仓库）。请换一个空目录或让插件接管现有仓库。')
            }
            const behind = Number((await gitOrNull(['rev-list', '--count', 'HEAD..FETCH_HEAD'], { cwd: root })) || 0)
            if (behind > 0) {
              const pre = await commitAll(root, '本地改动（rebase 前）', token)
              if (pre) steps.push(`rebase 前提交 ${pre.sha}`)
              const rebase = await runGit(['rebase', 'FETCH_HEAD'], { cwd: root, token, timeoutMs: 180000 })
              if (rebase.code !== 0) {
                await runGit(['rebase', '--abort'], { cwd: root, token })
                throw new Error('拉取时发生冲突，已回滚。请手动解决冲突后再同步。')
              }
              steps.push(`已 rebase 到远端（${behind} 个远端提交）`)
            }
          }
        } else {
          steps.push('远端分支还不存在，将创建首个提交')
        }
      }

      // 2. 会话：先导入远端，再导出本地（含刚导入的）
      const state = readStateFor(config.workspace)
      if (config.syncSessions) {
        const imported = importWorkspaceSessions({
          workspace: resolve(config.workspace),
          sessionsRoot: config.sessionsRoot,
          fromDir: join(root, '.dsh-sync'),
          liveSessions,
          maxSessionBytes: config.maxSessionMB * 1024 * 1024,
        })
        if (imported.imported.length > 0) {
          steps.push(`导入 ${imported.imported.length} 个远端会话`)
        }
        const exported = exportWorkspaceSessions({
          workspace: resolve(config.workspace),
          sessionsRoot: config.sessionsRoot,
          outDir: join(root, '.dsh-sync'),
          maxSessionBytes: config.maxSessionMB * 1024 * 1024,
          writeTranscripts: config.writeTranscripts,
          cache: state.sessionCache || {},
        })
        if (exported.exported.length > 0) {
          steps.push(`导出 ${exported.exported.length} 个会话（${Math.round(exported.bytes / 1024)}KB）`)
        }
        if (exported.skipped.length > 0) {
          steps.push(`跳过 ${exported.skipped.length} 个会话`)
        }
        updateState(config.workspace, {
          sessionCache: exported.cache,
          lastSessionExportAt: Date.now(),
        })
      }

      // 4. 提交
      const commit = await commitAll(root, reason === 'turn-end' ? '每轮对话后自动同步' : reason, token)
      if (commit) steps.push(`提交 ${commit.sha}`)

      // 5. 推送：远端已有内容时只在本地确实领先时才推
      let pushed = false
      if (opts.push !== false) {
        const hasHead = (await gitOrNull(['rev-parse', '--verify', 'HEAD'], { cwd: root })) !== null
        if (hasHead) {
          let ahead = 1
          if (remote.ok) {
            ahead = Number((await gitOrNull(['rev-list', '--count', 'FETCH_HEAD..HEAD'], { cwd: root })) || 0)
          }
          if (!remote.ok || ahead > 0) {
            await pushRemote(root, config, token)
            pushed = true
            steps.push(`已推送到 ${displayRepo(config.repo)}#${config.branch}`)
          } else {
            steps.push('远端已是最新')
          }
        }
      }

      const result = {
        ok: true,
        message: steps.length > 0 ? steps.join('；') : '没有变化',
        pushed,
        commit,
        steps,
        ms: Date.now() - startedAt,
      }
      lastResult = { at: Date.now(), ok: true, message: result.message }
      updateState(config.workspace, {
        lastSyncAt: Date.now(),
        lastOk: true,
        lastMessage: result.message,
        lastPushAt: pushed ? Date.now() : state.lastPushAt || null,
        lastError: null,
      })
      return result
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error), token)
      const result = { ok: false, message, ms: Date.now() - startedAt }
      lastResult = { at: Date.now(), ok: false, message }
      if (config.workspace) {
        updateState(config.workspace, { lastSyncAt: Date.now(), lastOk: false, lastError: message })
      }
      log.error(message)
      return result
    } finally {
      try {
        release?.()
      } catch {
        /* ignore */
      }
      running = false
      if (pendingReason && !disposed) {
        const next = pendingReason
        pendingReason = null
        setTimeout(() => {
          syncNow({ reason: next }).catch(() => {})
        }, 1500)
      }
    }
  }

  function schedule(reason = 'turn-end') {
    const config = readConfig()
    if (disposed || !config.enabled || !config.autoPush || !isConfigured(config)) return false
    if (running) {
      pendingReason = reason
      return true
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      syncNow({ reason }).catch(() => {})
    }, config.debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
    return true
  }

  function turnEnded(session) {
    const cwd = session?.header?.cwd
    const config = readConfig()
    if (!cwd || !config.workspace) return false
    if (!samePath(cwd, config.workspace)) return false
    return schedule('turn-end')
  }

  function dispose() {
    disposed = true
    if (timer) clearTimeout(timer)
    timer = null
  }

  return {
    noteLive,
    forgetLive,
    turnEnded,
    schedule,
    syncNow,
    status,
    testConnection,
    dispose,
    get running() {
      return running
    },
  }
}
