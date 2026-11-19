/**
 * dsh-github-sync —— 把一个工作区同步到 GitHub。
 *
 * 三件事：
 *  1. 每轮对话结束（turn/end）后自动 git add/commit/push 工作区；
 *  2. 把该工作区的 DSH 会话导出到仓库 .dsh-sync/（原日志 + 可读 Markdown），
 *     换设备后拉取即可接着聊；
 *  3. 自带一个配置面板（/dsh-github-sync），不用手改 YAML。
 *
 * 设计取舍：
 *  - 不接管 git 凭据：有 token 时只在那条命令的 URL 里临时注入；
 *  - 不覆盖你的 .gitignore：自动排除写在 .git/info/exclude 的标记块里；
 *  - 会话导入只改 header 里的工作区路径，事件帧逐字节不动，避免破坏格式。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSyncEngine } from './lib/sync.js'
import { openExternal } from './lib/open.js'
import { simpleTool } from './lib/tool.js'
import {
  displayRepo, isConfigured, normalizeRepo, readConfig, writeConfig,
} from './lib/config.js'

export const name = 'github-sync'
export const inject = []

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const ROUTE = '/dsh-github-sync'
const PANEL_FILE = join(PACKAGE_ROOT, 'panel.html')

function safeHostIsLoopback(req) {
  const raw = String(req?.headers?.host || '')
  if (!raw) return true
  const host = (raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]).toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

/** 浏览器跨站 POST 会带 Origin；只放行本机来源，防止别的网页改配置。 */
function safeOrigin(req) {
  const origin = String(req?.headers?.origin || '')
  if (!origin) return true
  try {
    const url = new URL(origin)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1'
  } catch {
    return false
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolvePromise(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function statusText(state) {
  if (!state.configured) return '还没配置：先执行 /github-sync init 指定工作区，再填仓库与 token。'
  const lines = [
    `仓库：${state.repo}#${state.branch}`,
    `工作区：${state.workspace}`,
    `自动推送：${state.autoPush ? '开' : '关'}｜对话同步：${state.syncSessions ? '开' : '关'}｜token：${state.hasToken ? '已保存' : '未保存（用系统 git 凭据）'}`,
  ]
  if (state.git) {
    lines.push(`本地改动：${state.git.changes} 项${state.git.head ? `｜最新提交 ${state.git.head}` : '｜还没有提交'}`)
  }
  if (state.sessions) lines.push(`仓库里已导出会话：${state.sessions.exported} 个`)
  if (state.state?.lastSyncAt) {
    const when = new Date(state.state.lastSyncAt).toLocaleString('zh-CN')
    lines.push(`上次同步：${when} · ${state.state.lastOk ? '成功' : '失败'}${state.state.lastError ? `（${state.state.lastError}）` : ''}`)
  }
  return lines.join('\n')
}

function applyConfigPatch(patch) {
  const next = {}
  if (typeof patch.workspace === 'string') {
    next.workspace = patch.workspace.trim() ? resolve(patch.workspace.trim()) : ''
  }
  if (typeof patch.repo === 'string') {
    const value = patch.repo.trim()
    next.repo = value ? normalizeRepo(value) : ''
  }
  if (typeof patch.branch === 'string' && patch.branch.trim()) next.branch = patch.branch.trim()
  if (typeof patch.proxy === 'string') next.proxy = patch.proxy.trim()
  if (typeof patch.token === 'string' && patch.token.trim()) next.token = patch.token.trim()
  if (patch.clearToken === true) next.token = ''
  for (const key of ['autoPush', 'pullOnStart', 'syncSessions', 'writeTranscripts', 'excludeSecrets', 'enabled']) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key]
  }
  for (const key of ['maxFileMB', 'maxSessionMB', 'debounceMs']) {
    if (Number.isFinite(Number(patch[key]))) next[key] = Number(patch[key])
  }
  return writeConfig(next)
}

export function apply(ctx, config) {
  let webServerRef = null
  const panelUrl = () => {
    try {
      if (webServerRef && typeof webServerRef.getOrigin === 'function') {
        return `${webServerRef.getOrigin()}${ROUTE}`
      }
    } catch {
      /* 端口还没绑定 */
    }
    const envUrl = String(process.env.DSH_WEB_URL || '').trim()
    if (/^https?:\/\//i.test(envUrl)) return `${envUrl.replace(/\/+$/, '')}${ROUTE}`
    return null
  }
  const openPanel = () => {
    const url = panelUrl()
    if (!url) return { url: null, opened: false }
    return { url, opened: openExternal(url) }
  }
  const engine = createSyncEngine({
    logger: {
      info: (message) => ctx.logger?.info?.(`[github-sync] ${message}`),
      warn: (message) => ctx.logger?.warn?.(`[github-sync] ${message}`),
      error: (message) => ctx.logger?.error?.(`[github-sync] ${message}`),
    },
  })

  // ---- 会话跟踪：谁是本进程里还开着的会话（导入时不覆盖）----
  ctx.on('session/event', (session, event) => {
    if (!session?.id) return
    engine.noteLive(session.id)
    if (event?.type === 'turn/end') engine.turnEnded(session)
  })
  ctx.on('session/disposed', (session) => engine.forgetLive(session?.id))
  ctx.effect(() => () => engine.dispose())

  // ---- 启动拉取：换设备打开就先把远端同步下来 ----
  const startTimer = setTimeout(() => {
    const current = readConfig()
    if (current.enabled && current.pullOnStart && isConfigured(current)) {
      engine.syncNow({ reason: '启动同步' }).catch(() => {})
    }
  }, 15000)
  if (typeof startTimer.unref === 'function') startTimer.unref()
  ctx.effect(() => () => clearTimeout(startTimer))

  // ---- 给模型用的工具 ----
  ctx.inject(['tools'], (child) => {
    try {
      child.tools.register(simpleTool({
      name: 'github_sync',
      description:
        '把当前工作区同步到 GitHub（git add/commit/push），并顺带导出/导入该工作区的 DSH 对话记录。'
        + '动作：status 查看状态；sync 拉取+推送；push 只提交推送；pull 只拉取并导入对话；init 把当前会话的工作区设为同步目标。'
        + '用户说“同步一下/推到 GitHub/拉一下最新/换设备接着聊”时用它。token 由用户在本地面板配置，不要向用户索要 token 明文。',
      parameters: {
        action: {
          type: 'string',
          enum: ['status', 'sync', 'push', 'pull', 'init'],
          description: 'status 查看状态；sync 拉取+推送；push 只提交推送；pull 只拉取；init 把当前会话工作区设为同步目标',
        },
      },
      text: (value) => String(value?.message ?? ''),
      async execute(args, exec) {
        const action = String(args.action || 'status').toLowerCase()
        if (action === 'status') {
          const state = await engine.status()
          return { ok: true, message: statusText(state), state }
        }
        if (action === 'init') {
          const cwd = exec?.agent?.session?.header?.cwd
          if (!cwd) return { ok: false, message: '拿不到当前会话的工作区，请用 /github-sync workspace <路径> 指定' }
          applyConfigPatch({ workspace: cwd })
          const state = await engine.status()
          const panel = openPanel()
          return {
            ok: true,
            message: `已把同步工作区设为：${cwd}\n`
              + (panel.url
                ? `${panel.opened ? '已打开配置面板' : '配置面板'}：${panel.url}\n`
                : `配置面板：${ROUTE}\n`)
              + statusText(state),
            state,
          }
        }
        const result = await engine.syncNow({
          reason: action === 'push' ? '手动推送' : action === 'pull' ? '手动拉取' : '手动同步',
          pull: action !== 'push',
          push: action !== 'pull',
        })
        const state = await engine.status()
        return { ok: result.ok, message: result.message, state }
      },
      }))
    } catch (error) {
      ctx.logger?.warn?.(`[github-sync] 注册工具失败：${error?.message || error}`)
    }
  })

  // ---- 斜杠命令 ----
  ctx.inject(['commands'], (child) => {
    try {
      child.commands.register({
      definitionId: 'dsh-github-sync',
      name: 'github-sync',
      description: '把当前工作区同步到 GitHub（配置 / 推送 / 拉取 / 对话同步）',
      input: {
        hint: 'status | init | sync | push | pull | repo <owner/repo> | branch <名> | token <token> | workspace <路径> | on | off | open',
      },
      // token 会出现在命令行里，绝不写进会话日志
      recordInput: false,
      async handler(invocation) {
        const raw = String(invocation?.rawInput || '').trim()
        const [head, ...restParts] = raw.split(/\s+/)
        const action = (head || 'status').toLowerCase()
        const rest = restParts.join(' ').trim()
        try {
          if (action === 'status') {
            return { kind: 'success', text: statusText(await engine.status()) }
          }
          if (action === 'init') {
            const cwd = invocation?.agent?.session?.header?.cwd
            if (!cwd) return { kind: 'error', text: '拿不到当前会话的工作区，请用 /github-sync workspace <路径>' }
            applyConfigPatch({ workspace: cwd })
            const panel = openPanel()
            return {
              kind: 'success',
              text: `已把同步工作区设为：${cwd}\n`
                + (panel.url
                  ? `${panel.opened ? '已打开配置面板' : '配置面板'}：${panel.url}\n填好仓库与 token 后点「立即同步」即可。`
                  : '配置面板：/dsh-github-sync（拿不到完整地址，请在浏览器里打开 DSH 后加这个路径）'),
            }
          }
          if (action === 'workspace') {
            if (!rest) return { kind: 'error', text: '用法：/github-sync workspace D:\\path\\to\\project' }
            const updated = applyConfigPatch({ workspace: rest })
            return { kind: 'success', text: `工作区已设为：${updated.workspace}` }
          }
          if (action === 'repo') {
            if (!rest) return { kind: 'error', text: '用法：/github-sync repo <owner/repo 或仓库 URL>' }
            const updated = applyConfigPatch({ repo: rest })
            return { kind: 'success', text: `仓库已设为：${displayRepo(updated.repo)}` }
          }
          if (action === 'branch') {
            if (!rest) return { kind: 'error', text: '用法：/github-sync branch main' }
            const updated = applyConfigPatch({ branch: rest })
            return { kind: 'success', text: `分支已设为：${updated.branch}` }
          }
          if (action === 'token') {
            if (!rest) {
              const current = readConfig()
              return { kind: 'success', text: current.token ? '已保存 token（不回显）' : '还没有 token，用系统 git 凭据' }
            }
            applyConfigPatch({ token: rest })
            return { kind: 'success', text: 'token 已保存到本机 ~/.dsh/github-sync/config.json（不会进仓库、不会写进对话日志）' }
          }
          if (action === 'on' || action === 'off') {
            applyConfigPatch({ enabled: action === 'on' })
            return { kind: 'success', text: `自动同步已${action === 'on' ? '开启' : '关闭'}` }
          }
          if (action === 'sessions') {
            const on = rest !== 'off'
            applyConfigPatch({ syncSessions: on })
            return { kind: 'success', text: `对话同步已${on ? '开启' : '关闭'}` }
          }
          if (action === 'test') {
            const result = await engine.testConnection()
            return { kind: result.ok ? 'success' : 'error', text: result.message }
          }
          if (action === 'open') {
            const panel = openPanel()
            if (!panel.url) return { kind: 'error', text: `拿不到面板完整地址，请手动访问 DSH 地址后的 ${ROUTE}` }
            return { kind: 'success', text: `已${panel.opened ? '打开' : '生成'}配置面板：${panel.url}` }
          }
          if (action === 'push' || action === 'pull' || action === 'sync') {
            const result = await engine.syncNow({
              reason: action === 'push' ? '手动推送' : action === 'pull' ? '手动拉取' : '手动同步',
              pull: action !== 'push',
              push: action !== 'pull',
            })
            return { kind: result.ok ? 'success' : 'error', text: result.message }
          }
          return { kind: 'error', text: `不认识的子命令：${action}。可用：status/init/sync/push/pull/repo/branch/token/workspace/on/off/sessions/test/open` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
      })
    } catch (error) {
      ctx.logger?.warn?.(`[github-sync] 注册命令失败：${error?.message || error}`)
    }
  })

  // ---- 本地面板 + API ----
  ctx.inject(['webServer'], (child) => {
    webServerRef = child.webServer
    const register = (path, handler) => {
      try {
        return child.webServer.register({ kind: 'exact', path, handler })
      } catch (error) {
        ctx.logger?.warn?.(`[github-sync] 注册路由 ${path} 失败：${error?.message || error}`)
        return () => {}
      }
    }
    const guard = (req, res) => {
      if (safeHostIsLoopback(req) && safeOrigin(req)) return true
      sendJson(res, 403, { ok: false, error: '只接受本机访问' })
      return false
    }

    child.effect(() => {
      const disposers = []
      disposers.push(register(ROUTE, (req, res) => {
        if (!guard(req, res)) return
        try {
          const html = readFileSync(PANEL_FILE)
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
          })
          res.end(html)
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`面板读取失败：${error.message}`)
        }
      }))

      disposers.push(register(`${ROUTE}/api/state`, async (req, res) => {
        if (!guard(req, res)) return
        try {
          const config = readConfig()
          const state = await engine.status()
          sendJson(res, 200, {
            ok: true,
            panelUrl: panelUrl(),
            config: {
              workspace: config.workspace,
              repo: config.repo ? displayRepo(config.repo) : '',
              branch: config.branch,
              proxy: config.proxy,
              hasToken: Boolean(config.token),
              enabled: config.enabled,
              autoPush: config.autoPush,
              syncSessions: config.syncSessions,
              writeTranscripts: config.writeTranscripts,
              excludeSecrets: config.excludeSecrets,
              maxFileMB: config.maxFileMB,
              maxSessionMB: config.maxSessionMB,
              sessionsRoot: config.sessionsRoot,
            },
            status: state,
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      }))

      disposers.push(register(`${ROUTE}/api/config`, async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        try {
          const patch = await readBody(req)
          const updated = applyConfigPatch(patch)
          sendJson(res, 200, {
            ok: true,
            config: {
              workspace: updated.workspace,
              repo: updated.repo ? displayRepo(updated.repo) : '',
              branch: updated.branch,
              proxy: updated.proxy,
              hasToken: Boolean(updated.token),
              enabled: updated.enabled,
              autoPush: updated.autoPush,
              syncSessions: updated.syncSessions,
              writeTranscripts: updated.writeTranscripts,
              excludeSecrets: updated.excludeSecrets,
              maxFileMB: updated.maxFileMB,
              maxSessionMB: updated.maxSessionMB,
            },
          })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message })
        }
      }))

      disposers.push(register(`${ROUTE}/api/action`, async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        try {
          const body = await readBody(req)
          const action = String(body.action || '')
          if (action === 'test') {
            const result = await engine.testConnection()
            return sendJson(res, 200, { ok: result.ok, message: result.message })
          }
          if (action === 'push' || action === 'pull' || action === 'sync') {
            const result = await engine.syncNow({
              reason: action === 'push' ? '面板推送' : action === 'pull' ? '面板拉取' : '面板同步',
              pull: action !== 'push',
              push: action !== 'pull',
            })
            return sendJson(res, 200, { ok: result.ok, message: result.message, steps: result.steps || [] })
          }
          return sendJson(res, 400, { ok: false, error: `不认识的 action：${action}` })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      }))

      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    })
  })

  // 配置写了但插件启动早于 webServer 时，面板仍然可用（上面的 inject 会等到服务就绪）
  void config
}
