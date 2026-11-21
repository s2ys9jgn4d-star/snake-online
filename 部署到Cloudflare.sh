#!/usr/bin/env bash
# 一条命令把「联机贪吃蛇」推到 Cloudflare 免费版（不需要信用卡、不需要一直开电脑）
# 组成：Worker（Durable Object 里的游戏世界）+ Pages（静态页 + /api 与 WebSocket 转发）
# 因为 *.workers.dev 在国内被污染，对外只用 pages.dev 的域名。
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "== 1/4 生成 seed.json（把 data/*.json 带过去）"
cd "$ROOT/worker" && node gen-seed.cjs

echo "== 2/4 部署 Worker"
cd "$ROOT/worker" && npx wrangler deploy

echo "== 3/4 同步静态文件到 Pages 目录（排除 Pages 专用代理文件）"
mkdir -p "$ROOT/cf-pages/site"
rsync -a --delete --exclude '_worker.js' --exclude '.assetsignore' "$ROOT/dist/" "$ROOT/cf-pages/site/"

echo "== 4/4 部署 Pages"
cd "$ROOT/cf-pages" && npx wrangler pages deploy site --project-name=snake-online --branch=main --commit-dirty=true

echo
echo "完成：https://snake-online-21s.pages.dev"
