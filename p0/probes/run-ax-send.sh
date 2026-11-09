#!/bin/sh
# Runs the AX send probe against the running ChatGPT/Codex desktop app.
# Kept as a script so the Chinese arguments never have to go through a shell line.
set -e
exec "$HOME/bin/ax-send" com.openai.codex - "Bridge AX 通道测试：只回复 OK-AX" \
  /Users/gowinder/code/gowinder/agent-bridge/ax-send-dump.txt --send-only
