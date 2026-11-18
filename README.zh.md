# dsh-github-sync

把**一个工作区**同步到 GitHub 的 DeepSeek Harness 插件。

- 每轮对话结束（`turn/end`）自动 `git add / commit / push`，代码和文件立刻上 GitHub；
- 把该工作区的 DSH 对话一起带上去：仓库里 `.dsh-sync/` 下同时存**原会话日志**和**可读 Markdown**；
- 换设备装同一个插件、填同一个仓库，拉取后代码和对话都能接上；
- 自带一个本地面板 `/dsh-github-sync`，不用手改 YAML，也不用把 token 交给模型；
- 模型也可以直接调用 `github_sync` 工具（`status / sync / push / pull / init`），你只要说“同步一下”。

> **本机状态**：插件安装在 `C:\Users\A\.dsh\plugins\dsh-github-sync`，已用 junction 链接进
> `C:\Users\A\.dsh\profiles\desktop\node_modules\dsh-github-sync`，并在 profile 的 `cordis.patch.yml` 里启用。
> 面板、API、`github_sync` 工具都已验证可用；配置还是空的，按下面「首次配置」走一遍即可。
>
> 工作区里的 `D:\新建文件夹 (2)\dsh-github-sync` 是源码/备份副本；改代码后把它同步回安装目录，
> 等 HMR 重新加载（或重启 DSH）即可。日常使用不需要动这两个目录。

## 首次配置（两种方式，二选一）

### A. 最快：在要同步的会话里

```text
/github-sync init                    # 把当前会话的工作区设为同步目标
/github-sync repo owner/repo
/github-sync token ghp_xxxxxxxx      # 私有仓库需要；不会写进会话日志
/github-sync push                    # 首次推送
```

之后每轮对话结束都会自动提交推送。用 `/github-sync status` 随时看状态。

### B. 面板

打开 `http://127.0.0.1:<你的 DSH 端口>/dsh-github-sync`（当前是 `http://127.0.0.1:51837/dsh-github-sync`），填：

| 字段 | 说明 |
|---|---|
| GitHub 仓库 | `owner/repo` 或 `https://github.com/owner/repo.git` |
| 分支 | 默认 `main`，首次推送会自动创建 |
| 工作区目录 | 要同步的项目目录，会被当成 git 仓库 |
| Personal Access Token | 私有仓库需要；只存在本机，见下文 |

然后点 **保存设置 → 测试连接 → 立即同步**。

### 装到别的设备

```powershell
# 1. 把整个 dsh-github-sync 目录拷到目标机器（例如 D:\tools\dsh-github-sync）
# 2. 链接进 profile 的 node_modules（Windows junction，不需要管理员）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-github-sync" `
  -Target "D:\tools\dsh-github-sync"
# 3. 在 profile 的 cordis.patch.yml 末尾追加：
#    - insert:
#        - id: github-sync
#          name: dsh-github-sync
```

然后重启一次 DSH（新装插件要重启才会加载；之后升级代码走 HMR 即可）。

## token 怎么给

- **私有仓库**：GitHub → Settings → Developer settings → Personal access tokens →
  Fine-grained token，仓库权限给 **Contents: Read and write**。
- **公开仓库**：只推不拉可以不给 token（走系统 git 凭据）；拉私有仓库还是需要。
- token 存在 `~/.dsh/github-sync/config.json`（0600），`git` 命令只在**当次** URL 里临时注入，
  不会写进 `.git/config`、不会进仓库、不会出现在对话或日志里。
- 也可以不填 token，直接用机器上已经登录的 Git Credential Manager。

## 换设备怎么“接着聊”

1. 目标设备装好插件，面板里填**同一个仓库**（token 可选）。
2. 点 **拉取远端**，或直接打开 DSH（默认启动 15 秒后自动拉一次）。
3. 代码会更新到工作区；仓库里的 `.dsh-sync/sessions/` 会被导入本机 DSH 会话目录，
   header 里的工作区路径自动改成目标机器上的真实路径，所以点开就能继续。
4. 刷新一下 DSH 页面（必要时重启），侧边栏就能看到这些会话。

> 会话合并规则：只追加的日志按**事件行数更多的一方**胜出；正在使用的会话不会被覆盖。
> 两台设备同时改同一个会话时，较少的那份会被较新的覆盖（不会丢文件，代码仍走 git 冲突流程）。

## 仓库里多出来的东西

```text
<工作区>/
├─ .dsh-sync/
│  ├─ README.md                 说明
│  ├─ index.md                  对话清单
│  ├─ sessions/<id>/…           原会话日志（header 里的本机路径是 <workspace> 占位符）
│  └─ transcripts/<id>.md       可读对话记录（手机/网页直接看）
└─ …你的代码和文件
```

`.dsh-sync` 会跟着每轮对话更新；不想让对话进仓库，面板里关掉 **同步该工作区的对话** 即可。

## 安全与边界

- **不覆盖 `.gitignore`**：自动排除项写在 `.git/info/exclude` 的 `dsh-github-sync` 标记块里，
  包括 `node_modules/`、`.env`、`*.key`、`*.pem` 等；关掉“自动排除 .env / 密钥”可取消后者。
- **大文件**：超过「单文件上限」（默认 50MB）的未跟踪文件会被写进 exclude，不上传，并在结果里报数量。
- **大对话**：单会话超过「单会话上限」（默认 8MB）会跳过（含大量工具输出的会话很容易到几十 MB）。
- **不动你的 origin**：如果工作区已有 `origin` 且指向别处，插件只警告，仍按面板里配置的仓库推送。
- **冲突**：拉取用 `git rebase`；冲突会自动 `rebase --abort` 并报错，不会留下半拉子状态。
- **只在直连本机时可用**：面板和 API 只接受 `localhost / 127.0.0.1 / [::1]` 的 Host。
- **代码同步的是整个 git 仓库根目录**：如果工作区只是某个大仓库的子目录，会按仓库根同步（结果里会提示）。

## 已知限制

- 换设备后会话要**刷新页面/重启**才会出现在侧边栏（DSH 的会话列表是启动时扫盘的）。
- DSH 会话格式是 `session.v4`；两台设备最好用同一大版本的 DSH。
- 对话里的图片附件不会同步（只在 `~/.dsh/attachments` 本机），文字和工具调用记录完整。
- 首次推送大工作区可能比较久；之后每轮只传增量。

## 开发

```powershell
cd dsh-github-sync
node --test test/*.test.mjs
```

测试用本地裸仓库模拟 GitHub，覆盖：多帧 zstd 读写、会话导出/导入、两台设备双向同步、
密钥与大文件排除、重复同步不产生空提交。
