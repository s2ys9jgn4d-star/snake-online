#!/bin/zsh
# 双击即可：启动本地面板并在浏览器里打开
cd "$(dirname "$0")"
export CHEAT_PORT="${CHEAT_PORT:-8787}"
node server.js &
NODE_PID=$!
sleep 1.2
open "http://127.0.0.1:${CHEAT_PORT}"
wait $NODE_PID
