#!/usr/bin/env bash
# 部署联机贪吃蛇到 Cloudflare 免费版（不用信用卡、不用一直开电脑）
#   Worker  = 游戏逻辑（Durable Object）+ 整套静态页
#   Pages   = 只为国内能通的一个壳，把请求全转给 Worker；改了代码不用再发它
# 平时改完代码：GitHub 推上去，Workers 构建会自动部署；
# 没有接 Git 构建时，本地跑这个脚本的第 1、2 步即可。
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ "$1" != "--pages-only" ]; then
  echo "== 1/2 生成 seed.json（把 data/*.json 带过去）"
  cd "$ROOT/worker" && node gen-seed.cjs
  echo "== 2/2 部署 Worker（含静态页）"
  cd "$ROOT" && npx wrangler deploy
fi

if [ "$1" = "--pages" ] || [ "$1" = "--pages-only" ]; then
  echo "== 部署 Pages 转发壳（只有改了 cf-pages/functions 才需要）"
  mkdir -p "$ROOT/cf-pages/site"
  cd "$ROOT/cf-pages" && npx wrangler pages deploy site --project-name=snakes-online --branch=main --commit-dirty=true
fi

echo
echo "站点：https://snakes-online.pages.dev"
