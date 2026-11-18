# dsh-github-sync

A DeepSeek Harness plugin that keeps **one workspace** synced to GitHub.

- After every assistant turn (`turn/end`) it stages, commits and pushes the workspace.
- It also exports that workspace's DSH sessions into the repo under `.dsh-sync/`
  (raw session logs **and** readable Markdown transcripts).
- On another machine, install the plugin, point it at the same repo, pull, and the
  code plus conversations are imported back (session header paths are rewritten
  to the local workspace, so you can continue the conversation).
- Ships a local settings panel at `/dsh-github-sync`; tokens never reach the model.

See [README.zh.md](./README.zh.md) for the full Chinese documentation, setup flow
and limitations.

## Quick start

```text
/github-sync init
/github-sync repo owner/repo
/github-sync token ghp_xxx
/github-sync push
```

Or open `http://127.0.0.1:<dsh-port>/dsh-github-sync` and fill in the form.

## Tests

```powershell
node --test test/*.test.mjs
```
