# 🐍 联机贪吃蛇

多人实时对战的贪吃蛇，**零第三方依赖**的 Node.js 服务端（WebSocket 协议手写实现），支持网页、手机、桌面、鸿蒙全平台客户端。

- 🌐 网页版：打开即玩，无需安装
- 👥 房间系统：创建/加入房间，每个房间独立对局
- 💀 死亡掉落：蛇撞墙或撞到别人后，尸体会每隔一节变成食物，供其他玩家抢食
- 🏆 账号 + 排行榜：注册登录、历史最高分排名
- 💬 对局内聊天
- 🧩 Scratch 扩展：可以在 Scratch 3 / TurboWarp 里用积木调用联机接口

---

## 快速开始

需要 Node.js 14+，**不需要 `npm install`**（项目没有任何依赖）。

```bash
node server.js
```

默认监听 `8180` 端口，浏览器打开 <http://localhost:8180> 即可。

同一 Wi-Fi 下的其他人用 `http://<你的内网IP>:8180` 访问。

> 想公网访问可以用 [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)：`tailscale funnel --bg 8180`

---

## 下载安装包

前往 [Releases](https://github.com/s2ys9jgn4d-star/snake-online/releases) 下载对应平台：

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS | `snake-online-macos.dmg` | 原生 WKWebView 窗口，双击安装 |
| Windows | `snake-online-win64.zip` | 需 WebView2 Runtime（Win11 自带） |
| Linux | `snake-online-linux.deb` | Debian / Ubuntu / 深度 |
| Android | `snake-online-android.apk` | Android 5.0+ |
| iOS | `snake-online-ios-unsigned.ipa` | 未签名，需 Sideloadly / AltStore 自签 |
| HarmonyOS NEXT | `snake-online-harmony-unsigned.hap` | 未签名，需真机 UDID 签名后安装 |
| Scratch | `snake-online-scratch.sb3` | 导入 TurboWarp / Scratch 使用 |

---

## 目录结构

```
snake-online/
├── server.js              # 服务端：HTTP 静态服务 + 手写 WebSocket + REST API
├── dist/                  # 线上发布的静态文件（服务端直接对外提供这个目录）
│   ├── index.html         #   下载中心
│   ├── play.html          #   电脑版游戏页面
│   ├── mobile.html        #   手机版游戏页面
│   ├── game.js            #   电脑版逻辑（渲染 / 输入 / 房间 / 聊天）
│   ├── mobile.js          #   手机版逻辑（触屏方向键）
│   ├── style.css
│   ├── mobile.css
│   ├── snake-ext.js       #   Scratch 扩展（联机积木）
│   └── scratch-in-scratch.js  # 在 Scratch 里套娃打开 Scratch 编辑器
├── public/                # 客户端源码（打包前的源文件）
├── pack/                  # 各平台打包工程（ui2 = 桌面全屏版，ui2-phone = 手机版）
├── data/                  # 运行时数据：users.json / scores.json（已被 .gitignore 排除）
└── 安装包/                # 打包产物
```

`data/` 目录**不在仓库里**，服务端首次启动会自动创建。里面存放账号和排行榜数据，不要提交到公开仓库。

---

## 服务端设计

整套服务端只用 Node 标准库，没有引入任何框架：

| 模块 | 实现方式 |
|---|---|
| HTTP 静态服务 | `http` 模块 + 手动 MIME 映射 |
| WebSocket | 手写 RFC 6455 握手（`Sec-WebSocket-Accept` 计算、帧解析、掩码处理） |
| 密码存储 | `crypto.scryptSync`（cost 16384）+ `timingSafeEqual` 校验 |
| 数据持久化 | JSON 文件 + 原子写入（先写 `.new` 再 `renameSync`） |
| 会话 | 内存 `Map<token, username>` + `Authorization: Bearer` |
| 房间 | 每个房间独立 `players` / `foods` / 定时器，互不干扰 |

### 手感优化

- **本地输入预测**：方向指令带序号，服务端回显 `lastSeq` 校正；延迟超过 80ms 时自动关闭预测，避免抽搐
- **死亡外推渲染**：按 `(now - curAt) / tick` 推算位置，让画面在低帧率下依旧顺滑

### 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | 注册 |
| POST | `/api/login` | 登录，返回 token |
| GET | `/api/scores` | 排行榜 |
| POST | `/api/delete-account` | 注销账号（需 token + 密码） |
| WS | `/ws` | 游戏连接（加入房间、方向、聊天） |

---

## Scratch 扩展

`dist/snake-ext.js` 是给 Scratch 3 / TurboWarp 用的联机扩展：

1. 打开 TurboWarp 桌面版 → 添加扩展 → 选择「加载本地扩展文件」→ 选 `snake-ext.js`
2. 用积木「启动联机 服务器地址 [ ] 用户名 [ ] 密码 [ ]」连接服务端
3. 之后可以用积木读取玩家位置、发送方向、发聊天

`dist/scratch-in-scratch.js` 是「在 Scratch 里打开 Scratch 编辑器」的趣味扩展，点击积木会全屏嵌入一个可编程的 Scratch 编辑器。

---

## 已支持平台

macOS · Windows · Linux · Android · iOS · HarmonyOS NEXT · 网页 · Scratch

打包脚本依赖各平台工具链（Xcode / Android SDK / dpkg / hvigorw），产物已放在 `安装包/` 与 Releases。

---

## 许可证

仅供学习交流使用。
