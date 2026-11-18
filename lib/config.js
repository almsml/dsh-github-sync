/**
 * 配置与状态。配置放在 ~/.dsh/github-sync/config.json（0600），不进仓库；
 * 会话导出缓存等运行状态放 state.json，避免每次同步都重写同一批文件。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function stateDir() {
  return join(dshHome(), 'github-sync')
}

export function configPath() {
  return join(stateDir(), 'config.json')
}

export function defaultSessionsRoot() {
  return join(dshHome(), 'sessions')
}

export const DEFAULT_EXCLUDES = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.pyc',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.dsh-sync/.lock',
]

export const SECRET_EXCLUDES = [
  '.env',
  '.env.*',
  '*.env',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  'id_rsa*',
  'id_ed25519*',
  '.credentials*',
  '*credentials*.json',
]

export function defaults() {
  return {
    version: 1,
    enabled: true,
    workspace: '',
    repo: '',
    branch: 'main',
    token: '',
    autoPush: true,
    pullOnStart: true,
    debounceMs: 8000,
    syncSessions: true,
    writeTranscripts: true,
    excludeSecrets: true,
    maxFileMB: 50,
    maxSessionMB: 8,
    proxy: '',
    sessionsRoot: '',
    excludePatterns: [...DEFAULT_EXCLUDES],
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function atomicJson(file, value) {
  mkdirSync(stateDir(), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* Windows 上可忽略 */
  }
  renameSync(tmp, file)
}

/** 读配置（带默认值），不抛异常。 */
export function readConfig() {
  const file = configPath()
  const stored = existsSync(file) ? readJson(file, {}) : {}
  const merged = { ...defaults(), ...(stored && typeof stored === 'object' ? stored : {}) }
  if (Array.isArray(stored?.excludePatterns)) merged.excludePatterns = stored.excludePatterns.filter((x) => typeof x === 'string')
  merged.branch = String(merged.branch || 'main').trim() || 'main'
  merged.workspace = String(merged.workspace || '').trim()
  merged.repo = String(merged.repo || '').trim()
  merged.proxy = String(merged.proxy || '').trim()
  merged.sessionsRoot = String(merged.sessionsRoot || '').trim() || defaultSessionsRoot()
  merged.debounceMs = Math.max(1000, Math.min(10 * 60 * 1000, Number(merged.debounceMs) || 8000))
  merged.maxFileMB = Math.max(1, Math.min(2048, Number(merged.maxFileMB) || 50))
  merged.maxSessionMB = Math.max(1, Math.min(1024, Number(merged.maxSessionMB) || 8))
  return merged
}

/** 写入部分配置，返回写入后的完整配置。 */
export function writeConfig(patch) {
  const current = readConfig()
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  next.version = 1
  atomicJson(configPath(), next)
  return readConfig()
}

/** 配置里是否已经可用（工作区 + 仓库）。 */
export function isConfigured(config) {
  return Boolean(config && config.workspace && config.repo)
}

/** 仓库输入归一化：支持 owner/repo、https、ssh、本地路径。 */
export function normalizeRepo(input) {
  let value = String(input || '').trim()
  if (!value) return ''
  value = value.replace(/^git\+/, '')
  // owner/repo
  if (/^[\w.-]+\/[\w.-]+$/.test(value) && !/^[A-Za-z]:/.test(value)) {
    return `https://github.com/${value.replace(/\.git$/, '')}.git`
  }
  if (/^https?:\/\/github\.com\/[^/]+\/[^/]+$/i.test(value)) return `${value.replace(/\.git$/, '')}.git`
  if (/^https?:\/\//i.test(value)) return value
  if (/^git@[^:]+:.+/.test(value)) return value
  if (value.startsWith('file://')) return value
  // 本地绝对路径（测试或局域网共享）
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')) return value
  return value
}

/** 给界面看的仓库名（去掉凭据与 .git）。 */
export function displayRepo(repo) {
  let value = String(repo || '')
  value = value.replace(/\/\/[^/@]+@/, '//')
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(value)
  if (m) return `${m[1]}/${m[2]}`
  return value.replace(/\.git$/, '')
}

/** 实际用于 fetch/push 的 URL（带 token 时临时注入，不落盘）。 */
export function authUrl(repo, token) {
  const value = String(repo || '')
  const secret = String(token || '').trim()
  if (!secret) return value
  if (!/^https?:\/\//i.test(value)) return value
  return value.replace(/^(https?:\/\/)/i, `$1x-access-token:${encodeURIComponent(secret)}@`)
}

/** 去掉输出里的 token，避免写进日志/错误信息。 */
export function redact(text, token) {
  let out = String(text ?? '')
  const secret = String(token || '').trim()
  if (!secret) return out
  out = out.split(secret).join('***')
  try {
    out = out.split(encodeURIComponent(secret)).join('***')
  } catch {
    /* ignore */
  }
  return out
}

export function workspaceKey(workspace) {
  return createHash('sha1').update(resolve(workspace).toLowerCase()).digest('hex').slice(0, 12)
}

function statePath() {
  return join(stateDir(), 'state.json')
}

/** 读某个工作区的运行状态。 */
export function readState(workspace) {
  const all = existsSync(statePath()) ? readJson(statePath(), {}) : {}
  const key = workspace ? workspaceKey(workspace) : ''
  return { all, state: (key && all[key]) || {} }
}

/** 合并写入某个工作区的运行状态。 */
export function updateState(workspace, patch) {
  const { all } = readState(workspace)
  const key = workspaceKey(workspace)
  const next = { ...all, [key]: { ...(all[key] || {}), ...patch, updatedAt: Date.now() } }
  atomicJson(statePath(), next)
  return next[key]
}

export function readRawState() {
  return existsSync(statePath()) ? readJson(statePath(), {}) : {}
}
