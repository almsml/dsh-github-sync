/**
 * 极薄的 git 调用层：只负责跑命令、限时、收输出、去掉 token。
 * 不接管凭据：有 token 时临时把 token 塞进 URL 并禁用 credential helper，
 * 没 token 时沿用系统 git 凭据（GitHub Desktop / Git Credential Manager 都行）。
 */
import { spawn } from 'node:child_process'

const MAX_OUTPUT = 4 * 1024 * 1024

// 进程内当前使用的代理（同步是串行的，所以用一个模块级值即可）。
// 为空时回退到 HTTPS_PROXY / HTTP_PROXY 环境变量。
let runtimeProxy = ''

/** 设置后续 git 命令使用的 HTTP(S) 代理。 */
export function setGitProxy(proxy) {
  runtimeProxy = String(proxy || '').trim()
}

/** 当前生效的代理：显式配置 > 环境变量。 */
export function currentGitProxy() {
  if (runtimeProxy) return runtimeProxy
  return String(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '').trim()
}

/**
 * @param {string[]} args
 * @param {{cwd:string, token?:string, timeoutMs?:number, env?:Record<string,string>, input?:string}} options
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean}>}
 */
export function runGit(args, options) {
  const { cwd, token, timeoutMs = 120000, input } = options
  const proxy = String(options.proxy ?? currentGitProxy()).trim()
  const baseArgs = token ? ['-c', 'credential.helper=', ...args] : [...args]
  const finalArgs = proxy
    ? ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`, ...baseArgs]
    : baseArgs
  const env = {
    ...process.env,
    ...(options.env || {}),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    // 避免继承用户 shell 里的 locale 造成输出乱码判断失败
    LC_ALL: 'C',
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', finalArgs, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message || error), timedOut: false })
      return
    }
    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (outBytes >= MAX_OUTPUT) return
      outBytes += chunk.length
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (errBytes >= MAX_OUTPUT) return
      errBytes += chunk.length
      err.push(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: Buffer.concat(out).toString('utf8'), stderr: String(error?.message || error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      })
    })
    if (input !== undefined) {
      try {
        child.stdin.end(input)
      } catch {
        /* ignore */
      }
    } else {
      try {
        child.stdin.end()
      } catch {
        /* ignore */
      }
    }
  })
}

/** 跑 git，失败就抛错（错误里已去敏）。 */
export async function git(args, options) {
  const result = await runGit(args, options)
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    const suffix = result.timedOut ? '（超时）' : `（退出码 ${result.code}）`
    throw new Error(`git ${args.join(' ')} 失败${suffix}: ${detail || '无输出'}`)
  }
  return result.stdout
}

/** 跑 git，失败返回 null。 */
export async function gitOrNull(args, options) {
  const result = await runGit(args, options)
  return result.code === 0 ? result.stdout.trim() : null
}

/** 判断目录是否在一个 git 工作树里。 */
export async function isRepo(cwd) {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: 15000 })
  return result.code === 0 && result.stdout.trim() === 'true'
}

/** 仓库根目录（工作区可能在子目录里）。 */
export async function repoRoot(cwd) {
  const result = await runGit(['rev-parse', '--show-toplevel'], { cwd, timeoutMs: 15000 })
  return result.code === 0 ? result.stdout.trim() : null
}
