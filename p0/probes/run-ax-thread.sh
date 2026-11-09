#!/bin/sh
# Selects an existing conversation by title from the sidebar, then sends one message.
set -e
AX_THREAD="测试 Bridge AX 通道" exec "$HOME/bin/ax-send" com.openai.codex - \
  "Bridge AX 原会话测试：只回复 OK-AX2" \
  /Users/gowinder/code/gowinder/agent-bridge/ax-thread-dump.txt
