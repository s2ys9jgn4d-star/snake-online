#!/bin/bash
set -uo pipefail

LOG="/tmp/snake-funnel.log"
LOCK="/tmp/snake-funnel.lock"
PORT=8180

log(){ printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

[ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 1048576 ] && mv -f "$LOG" "$LOG.1"

if ! mkdir "$LOCK" 2>/dev/null; then log "上一次还在跑，跳过"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT

TS=""
for c in "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
         "/usr/local/bin/tailscale" \
         "/opt/homebrew/bin/tailscale"; do
  [ -x "$c" ] && TS="$c" && break
done
[ -z "$TS" ] && { log "找不到 tailscale 命令"; exit 1; }

if ! curl -sf -m 3 "http://127.0.0.1:$PORT/api/scores" >/dev/null; then
  log "本机 $PORT 没响应，先别开 Funnel"
  exit 1
fi

if ! "$TS" status >/dev/null 2>&1; then
  log "Tailscale 未运行，正在启动…"
  open -a Tailscale
fi

ready=0
for _ in $(seq 1 45); do
  out=$("$TS" status 2>/dev/null)
  if printf '%s' "$out" | grep -qiE 'stopped|logged out|not logged in'; then
    sleep 2
  else
    ready=1; break
  fi
done
[ "$ready" -eq 1 ] || { log "90 秒内仍未就绪，放弃"; exit 1; }

if "$TS" funnel status 2>/dev/null | grep -q 'Funnel on'; then
  log "Funnel 已在运行，无需处理"
  exit 0
fi

"$TS" funnel --bg "$PORT" >>"$LOG" 2>&1
if "$TS" funnel status 2>/dev/null | grep -q 'Funnel on'; then
  log "Funnel 已重新开启 ✅"
else
  log "Funnel 开启失败 ❌"
  exit 1
fi
