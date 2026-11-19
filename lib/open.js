/**
 * 用系统默认浏览器打开一个本机 URL。
 * 只用于打开插件自己的面板，不接收外部输入拼出的任意地址之外的内容。
 */
import { spawn } from 'node:child_process'

/**
 * @param {string} url 必须是 http(s) 地址
 * @returns {boolean} 是否成功拉起了打开命令（不代表浏览器一定弹出来）
 */
export function openExternal(url) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) return false
  try {
    let child
    if (process.platform === 'win32') {
      // start 的第一个引号参数是窗口标题，给空标题再给 URL
      child = spawn('cmd', ['/c', 'start', '', target], {
        detached: true, stdio: 'ignore', windowsHide: true,
      })
    } else if (process.platform === 'darwin') {
      child = spawn('open', [target], { detached: true, stdio: 'ignore' })
    } else {
      child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' })
    }
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
