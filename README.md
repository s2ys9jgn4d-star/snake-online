# 🐍 Snake Online

Real-time multiplayer Snake with a **zero-dependency** Node.js server (the WebSocket protocol is implemented by hand). Clients cover web, mobile and desktop.

- 🌐 Web: open and play, no installation
- 👥 Rooms: create or join a room; every room runs its own match
- 💀 Death drops: when a snake hits a wall or another snake, its body turns into food piece by piece for others to grab
- 🏆 Accounts + leaderboard: sign up, log in, all-time high scores
- 💬 In-match chat
- 🧩 Scratch extension: call the multiplayer API from Scratch 3 / TurboWarp blocks

---

## Quick start

Node.js 14+ is required. **No `npm install` needed** — the project has no dependencies.

```bash
node server.js
```

Listens on port `8180` by default; open <http://localhost:8180> in a browser.

Players on the same Wi-Fi can use `http://<your-lan-ip>:8180`.

> For public access you can use [Tailscale Funnel](https://tailscale.com/kb/1223/funnel): `tailscale funnel --bg 8180`

---

## Downloads

Grab the package for your platform from [Releases](https://github.com/s2ys9jgn4d-star/snake-online/releases):

| Platform | File | Notes |
|---|---|---|
| macOS | `snake-online-macos.dmg` | Native WKWebView window, install by double-clicking |
| Windows | `snake-online-win64.zip` | Requires WebView2 Runtime (bundled with Windows 11) |
| Linux | `snake-online-linux.deb` | Debian / Ubuntu / Deepin |
| Android | `snake-online-android.apk` | Android 5.0+ |
| iOS | `snake-online-ios-unsigned.ipa` | Unsigned; self-sign with Sideloadly / AltStore |
| Scratch | `snake-online-scratch.sb3` | Import into TurboWarp / Scratch |

---

## Repository layout

```
snake-online/
├── server.js              # Server: HTTP static serving + hand-written WebSocket + REST API
├── dist/                  # Published static assets (served directly by the server)
│   ├── index.html         #   Download hub
│   ├── play.html          #   Desktop game page
│   ├── mobile.html        #   Mobile game page
│   ├── game.js            #   Desktop logic (rendering / input / rooms / chat)
│   ├── mobile.js          #   Mobile logic (on-screen d-pad)
│   ├── style.css
│   ├── mobile.css
│   ├── snake-ext.js       #   Scratch extension (multiplayer blocks)
│   └── scratch-in-scratch.js  # Open a Scratch editor inside Scratch
├── public/                # Client source files (pre-packaging)
├── pack/                  # Packaging projects per platform (ui2 = desktop fullscreen, ui2-phone = mobile)
├── data/                  # Runtime data: users.json / scores.json (gitignored)
└── 安装包/                # Build artifacts
```

The `data/` directory is **not** committed; the server creates it on first launch. It holds accounts and leaderboard data and must never be pushed to a public repository.

---

## Server design

The whole server relies on Node's standard library only — no frameworks:

| Concern | Implementation |
|---|---|
| HTTP static serving | `http` module + hand-written MIME map |
| WebSocket | Hand-rolled RFC 6455 handshake (`Sec-WebSocket-Accept`, frame parsing, masking) |
| Password storage | `crypto.scryptSync` (cost 16384) verified with `timingSafeEqual` |
| Persistence | JSON files with atomic writes (write `.new`, then `renameSync`) |
| Sessions | In-memory `Map<token, username>` + `Authorization: Bearer` |
| Rooms | Each room owns its own `players` / `foods` / timers, fully isolated |

### Feel and responsiveness

- **Local input prediction**: direction commands carry a sequence number and the server echoes `lastSeq` to correct them; prediction is disabled automatically above 80 ms latency to avoid jitter
- **Extrapolated rendering on death**: positions are extrapolated as `(now - curAt) / tick` so motion stays smooth at low frame rates

### Main endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/register` | Sign up |
| POST | `/api/login` | Log in, returns a token |
| GET | `/api/scores` | Leaderboard |
| POST | `/api/delete-account` | Delete an account (token + password required) |
| WS | `/ws` | Game connection (join room, direction, chat) |

---

## Scratch extension

`dist/snake-ext.js` is the multiplayer extension for Scratch 3 / TurboWarp:

1. Open TurboWarp Desktop → add extension → choose "Load local extension file" → pick `snake-ext.js`
2. Use the block "start multiplayer server address [ ] username [ ] password [ ]" to connect
3. Then read player positions, send directions and chat through blocks

`dist/scratch-in-scratch.js` is the fun one: a block that opens a full-screen, fully editable Scratch editor inside Scratch.

---

## Supported platforms

macOS · Windows · Linux · Android · iOS · Web · Scratch

Packaging relies on each platform's toolchain (Xcode / Android SDK / dpkg); artifacts live in `安装包/` and in Releases.

---

## License

[MIT License](LICENSE) — free to use, modify and distribute; see the LICENSE file for details.
