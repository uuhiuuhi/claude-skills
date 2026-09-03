# 실제 CLI 검증 (지휘 실측 · 2026-09-02 22:27)

```
$ claude --version
2.1.250 (Claude Code)

$ codex --version
codex-cli 0.152.1

$ codex login status
Logged in using ChatGPT

$ where claude / codex
C:\Users\user\.local\bin\claude.exe
C:\Users\user\AppData\Roaming\npm\codex
C:\Users\user\AppData\Roaming\npm\codex.cmd

$ codex exec --help (핵심 옵션)
  -c, --config <key=value>
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
  -C, --cd <DIR>
      --skip-git-repo-check
      --ephemeral
      --output-schema <FILE>
      --json
  -o, --output-last-message <FILE>
```
