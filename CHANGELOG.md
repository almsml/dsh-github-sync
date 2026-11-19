# Changelog

## 0.3.0

- 新增：`/github-sync init`（以及 `github_sync` 的 `init` 动作）在设置好工作区后，
  自动用系统默认浏览器打开配置面板 `http://127.0.0.1:<当前端口>/dsh-github-sync`；
  `/github-sync open` 也可以随时重新打开。
- 面板地址通过 `webServer.getOrigin()` 实时获取，DSH 重启换端口后无需改配置。

## 0.2.0

- 新增：可选 HTTP(S) 代理。面板里填 `http://127.0.0.1:7890` 之类的地址即可；
  留空时回退到 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量。直连 GitHub 不通的网络现在也能自动推送。
- 新增：更严格的本地访问校验（Host + Origin），跨站页面无法改配置或触发同步。
- 修复：在没有代理、且远端不可达时，错误信息会明确给出连接失败原因，而不是只报 “同步失败”。

## 0.1.0

- 首个版本：工作区自动 `git add/commit/push`、DSH 会话导出/导入、可读 Markdown 记录、
  本地面板 `/dsh-github-sync`、`github_sync` 工具与 `/github-sync` 命令。
