#!/usr/bin/env bash
# 把联机贪吃蛇部署到 serv00（FreeBSD 共享主机）
# 用法：
#   SERV00_HOST=s1.serv00.com SERV00_USER=123abce00 APP_PORT=30001 ./部署到serv00.sh
# 可选：SSH_KEY（默认 ~/.ssh/id_ed25519），REMOTE_DIR（默认 ~/snake-online）
set -euo pipefail

HOST="${SERV00_HOST:?需要 SERV00_HOST，例如 s1.serv00.com}"
USER_="${SERV00_USER:?需要 SERV00_USER，例如 123abce00}"
APP_PORT="${APP_PORT:?需要 APP_PORT，面板里 Node 应用分配的那个端口}"
KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE="${REMOTE_DIR:-$HOME/snake-online}"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new $USER_@$HOST"

echo "① 远端建目录"
$SSH "mkdir -p $REMOTE/dist $REMOTE/data"

echo "② 上传代码"
scp -i "$KEY" server.js package.json mail.js "$USER_@$HOST:$REMOTE/"
scp -r -i "$KEY" bot "$USER_@$HOST:$REMOTE/"
scp -r -i "$KEY" dist "$USER_@$HOST:$REMOTE/"

echo "③ 上传数据（本地 data/ 里有账号就一起搬，没有就跳过）"
if [ -d data ] && ls data/*.json >/dev/null 2>&1; then
  scp -i "$KEY" data/*.json "$USER_@$HOST:$REMOTE/data/" || echo "  （data 上传失败，忽略）"
fi

echo "④ 停旧进程、起新进程"
$SSH "pkill -f 'node server.js' 2>/dev/null || true
      cd $REMOTE
      PORT=$APP_PORT SNAKE_DATA_DIR=$REMOTE/data nohup node server.js > run.log 2>&1 &
      sleep 2
      tail -n 20 run.log"

echo "⑤ 装 cron 守活（每 10 分钟看一次，挂了就拉起来）"
$SSH "crontab -l 2>/dev/null | grep -v 'snake-online/server.js' > /tmp/cron.snake || true
      echo '*/10 * * * * pgrep -f \"node server.js\" >/dev/null || (cd $REMOTE && PORT=$APP_PORT SNAKE_DATA_DIR=$REMOTE/data nohup node server.js >> run.log 2>&1 &)' >> /tmp/cron.snake
      crontab /tmp/cron.snake && crontab -l | tail -n 3"

echo "⑥ 本地探活"
curl -s -o /dev/null -w "http://$HOST:$APP_PORT/api/scores => %{http_code}\n" -m 8 "http://$HOST:$APP_PORT/api/scores" || true

echo "完成。浏览器打开 http://$HOST:$APP_PORT/play.html"
