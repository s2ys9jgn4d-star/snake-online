# snake-online Worker

把 `../server.js` 的 **WebSocket 游戏 + HTTP API** 原样搬到 Cloudflare Workers + Durable Objects。
静态页面仍由 Cloudflare Pages 托管，本 Worker 不提供静态文件。

## 文件

- `src/worker.js` —— Worker 入口（CORS / 路由 / 转发到 DO）
- `src/hub.js` —— `Hub` Durable Object（房间、玩家、食物、聊天、账号、排行榜、token）
- `seed.json` —— 由 `../data/users.json` + `../data/scores.json` 合成的初始数据
- `wrangler.toml` —— SQLite 版 DO（免费计划可用）

## 本地运行

```bash
cd worker
npm install
npx wrangler dev --port 8787 --local
```

首次启动时 DO storage 为空 → 自动用 `seed.json` 初始化（老账号、老排行榜都在）。
之后以 storage 为准，重启不会覆盖。

## 部署

```bash
cd worker
npx wrangler login          # 只需一次
npx wrangler deploy         # 生成 https://snake-online.<你的子域>.workers.dev
```

部署后地址类似 `https://snake-online.xxx.workers.dev`：

- API：`https://snake-online.xxx.workers.dev/api/...`
- WebSocket：`wss://snake-online.xxx.workers.dev/`（客户端连的是站点根路径，和原版一样接受任意路径升级；`/ws` 也可以）

> 客户端 `dist/game.js` / `dist/mobile.js` 里的 `FALLBACK_HTTP` / `FALLBACK_WS` 目前还写着 Tailscale Funnel 地址。
> 让 Pages 页面真正走 Worker，需要二者同源（Pages 自定义域名 + Worker 路由），或者在下次发布 Pages 时把这两个常量改成 Worker 地址。本 Worker 已开 CORS，跨域调用 API 没问题。

## 数据

`users` / `scores` / `tokens` 三份数据保存在 Durable Object 的 SQLite storage 里，
每次变化合并成一次 `put`（游戏中的分数变化延迟 300ms 合并写）。排行榜上限 50 条，与 Node 版一致。

## 与原版的已知差异

- WebSocket 心跳：Workers 不能发送 ping 帧，改为「30s 检查一次，75s 无消息就断开」后端的清理逻辑；客户端本来就每 2s 发 `{t:'ping'}`，所以实际体验无变化。
- 启动时不再打印局域网地址（Worker 没有终端）。
- 非白名单路径返回 `{"error":"not found"}`（原版是 `{"ok":false,"msg":"未找到"}`）。

## ⚠️ 免费计划的 CPU 限制（部署前必读）

Workers **免费计划每次调用只有 10ms CPU**，付费计划 30s。

`scrypt-js` 计算旧哈希（N=16384, r=8, p=1）实测约 **125ms 纯 CPU**（本机 Node 测得）。
`wrangler dev` 本地不限制 CPU，所以本机测试全部通过；但**部署到免费计划后 `/api/login`、`/api/register` 会超出 CPU 限制（错误 1102）**。

两条路：

1. **Workers Paid（$5/月）**：30s CPU，`scrypt-js` 照常用，老账号（含「公共账号」）直接能登录，完全兼容原版。
2. **必须留在免费计划**：把注册用的 `hashPass` 换成 WebCrypto PBKDF2、登录按哈希类型分流（PBKDF2 新账号 + scrypt 老账号）。新账号可用，但老账号在免费计划下仍会因为 scrypt 超出 CPU 而无法登录 → 实际操作上等于「老账号需重新注册」，`seed.json` 里的老账号也需要手工清掉才能腾出用户名。

密码兼容已用 seed 里的「公共账号」实测通过（见下方验证记录）。
