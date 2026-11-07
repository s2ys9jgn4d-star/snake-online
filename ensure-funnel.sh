#!/bin/bash
# 确保 Tailscale 与 Funnel 处于开启状态（开机/定时自检）
# 日志：/tmp/snake-funnel.log

TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
LOG="/tmp/snake-funnel.log"
echo "----- $(date '+%F %T') 开始检查 -----" >> "$LOG"

# 1) Tailscale 没跑就拉起来
if ! "$TS" status >/dev/null 2>&1; then
    echo "Tailscale 未运行，正在启动…" >> "$LOG"
    open -a Tailscale
fi

# 2) 最多等 90 秒让它连上
for _ in $(seq 1 45); do
    if "$TS" status 2>/dev/null | grep -qi "stopped"; then
        sleep 2
    else
        break
    fi
done

if "$TS" status 2>/dev/null | grep -qi "stopped"; then
    echo "Tailscale 仍未就绪，本次放弃" >> "$LOG"
    exit 1
fi

# 3) Funnel 已开就什么都不做
if "$TS" funnel status 2>/dev/null | grep -q "Funnel on"; then
    echo "Funnel 已在运行，无需处理" >> "$LOG"
    exit 0
fi

# 4) 重新开启
"$TS" funnel --bg 8180 >> "$LOG" 2>&1
if "$TS" funnel status 2>/dev/null | grep -q "Funnel on"; then
    echo "Funnel 已重新开启 ✅" >> "$LOG"
else
    echo "Funnel 开启失败 ❌" >> "$LOG"
    exit 1
fi
