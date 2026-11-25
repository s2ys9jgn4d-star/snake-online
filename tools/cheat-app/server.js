'use strict';
/*
 * 本地开挂面板
 *
 * 启动：  node server.js        （或者双击 开挂.command）
 * 界面：  http://127.0.0.1:8787
 *
 * 它做的事：用你自己的账号登录你的服务器，替你在房间里走位。
 * 只监听 127.0.0.1，不会对局域网开放；账号密码不会落盘。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Driver } = require('./driver');

const PORT = Number(process.env.CHEAT_PORT) || 8787;
const PUBLIC = path.join(__dirname, 'public');

const WHY = {
  deadWall: '撞墙了',
  deadSelf: '撞到自己了',
  deadOther: '撞到别人的身子了',
  '与对手迎头相撞': '和对手迎头撞上了'
};

let session = null; // 同时只跑一个

// ---------------- 会话 ----------------
class Session {
  constructor(opts) {
    this.base = String(opts.base || 'http://localhost:8180').replace(/\/+$/, '');
    this.user = String(opts.user || '').trim();
    this.pass = String(opts.pass || '');
    this.mode = String(opts.mode || 'create');     // create / join / first
    this.room = String(opts.room || '').trim();
    this.speed = opts.speed ? Number(opts.speed) : 0;
    this.running = false;
    this.ws = null;

    this.myId = null;
    this.players = [];
    this.foods = [];
    this.driver = null;
    this.cols = 42;
    this.rows = 30;

    this.seq = 0;
    this.decisions = 0;
    this.deaths = 0;
    this.wasAlive = true;
    this.respawnAt = 0;
    this.bestScore = 0;
    this.score = 0;
    this.len = 0;
    this.alive = false;
    this.roomName = '(未进房)';
    this.logs = [];
    this.reconnectAt = 0;
    this.rtt = 0;
    this.tickMs = 200;
    this.lastSpeedAt = 0;
  }

  log(text) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.logs.push(`[${t}] ${text}`);
    if (this.logs.length > 200) this.logs.shift();
    console.log(text);
  }

  async start() {
    if (!this.user || !this.pass) throw new Error('账号和密码都要填');
    this.log(`登录 ${this.base} …`);
    const r = await fetch(this.base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ u: this.user, p: this.pass })
    });
    const j = await r.json().catch(() => ({}));
    if (!j.token) throw new Error('登录失败：' + (j.msg || '用户名或密码不对'));
    this.token = j.token;
    this.log('登录成功，连接实时通道…');
    this.running = true;
    this.connect();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.running && this.ws && this.ws.readyState === 1) this.send({ t: 'ping', ts: Date.now() });
    }, 5000);
    return this.status();
  }

  connect() {
    if (!this.running) return;
    const url = this.base.replace(/^http/, 'ws') + '/';
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.log('已连接，开始鉴权');
      this.send({ t: 'auth', token: this.token });
    });

    this.ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      this.onMessage(m);
    });

    this.ws.addEventListener('close', () => {
      if (!this.running) return;
      this.log('连接断开，2 秒后重连');
      setTimeout(() => this.connect(), 2000);
    });

    this.ws.addEventListener('error', () => {});
  }

  send(o) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o));
  }

  onMessage(m) {
    switch (m.t) {
      case 'auth_ok':
        this.log('鉴权通过，找房间…');
        if (this.mode === 'create') {
          const name = this.room || (this.user + ' 的代打房');
          this.send({ t: 'create_room', name: name.slice(0, 20) });
        } else {
          this.send({ t: 'list_rooms' });
        }
        break;

      case 'rooms': {
        const list = m.items || [];
        let pick = null;
        if (this.mode === 'join' && this.room) {
          pick = list.find((x) => x.id === this.room || x.name === this.room);
          if (!pick) this.log('找不到房间「' + this.room + '」，改成自己建房');
        } else {
          pick = list.filter((x) => !x.hasPwd).sort((a, b) => b.count - a.count)[0];
        }
        if (pick) {
          this.log('加入房间 ' + pick.name);
          this.send({ t: 'join_room', id: pick.id });
        } else {
          const name = (this.room || this.user + ' 的代打房').slice(0, 20);
          this.log('自己建房 ' + name);
          this.send({ t: 'create_room', name });
        }
        break;
      }

      case 'joined_room':
        this.cols = m.cols || this.cols;
        this.rows = m.rows || this.rows;
        this.roomName = m.solo ? (m.soloOf || this.user) + ' 的单人房' : (m.roomName || this.roomName);
        this.driver = new Driver(this.cols, this.rows);
        this.driver.tickMs = m.tickMs || 200;
        this.driver.rtt = this.rtt;
        this.log(`进了「${this.roomName}」，棋盘 ${this.cols}×${this.rows}`);
        if (this.speed) {
          this.send({ t: 'speed', ms: this.speed });
          this.log('速度设为 ' + this.speed + 'ms/拍');
        }
        break;

      case 'pong':
        this.rtt = this.rtt ? Math.round(this.rtt * 0.7 + (Date.now() - m.ts) * 0.3) : (Date.now() - m.ts);
        if (this.driver) this.driver.rtt = this.rtt;
        this.maybeSlowDown();
        break;

      case 'state':
        this.onState(m);
        break;

      case 'sys':
        this.log('[服务器] ' + (m.msg || m.text || ''));
        break;

      case 'chat':
        if (m.from === '系统') this.log('[系统] ' + (m.text || ''));
        break;

      default:
        break;
    }
  }

  onState(m) {
    this.players = m.players || [];
    this.foods = m.foods || [];

    if (this.myId == null) {
      const cand = this.players.filter((p) => p.name === this.user);
      if (cand.length) this.myId = cand[cand.length - 1].id;
      else return;
    }

    const me = this.players.find((p) => p.id === this.myId);
    if (!me) return;
    if (this.driver && m.tickMs) this.driver.tickMs = m.tickMs;
    this.alive = !!me.alive;
    if (me.alive) {                       // 死了的时候快照里 body 是空的，别把身长写成 0
      this.score = me.score || 0;
      this.len = me.body ? me.body.length : 0;
    }
    if (this.score > this.bestScore) this.bestScore = this.score;

    if (!me.alive) {
      if (this.wasAlive) {
        this.wasAlive = false;
        this.deaths++;
        const why = WHY[me.deathReason] || '撞死了';
        this.log(`${why}（第 ${this.deaths} 次，身长 ${this.len}、${this.score} 分），0.6 秒后复活`);
        this.respawnAt = Date.now() + 600;
      } else if (this.respawnAt && Date.now() >= this.respawnAt) {
        this.respawnAt = 0;
        this.send({ t: 'respawn' });
      }
      return;
    }
    this.wasAlive = true;

    const dir = this.driver.command(me, this.players, this.foods, m.tick || 0);
    if (dir) {
      this.send({ t: 'dir', dir, seq: ++this.seq });
      this.decisions++;
    }
    this.driver.observe(me, m.tick || 0);
  }

  // 网络慢到一拍半以上、而自己又是房主，就把房间调慢一点，让指令来得及
  maybeSlowDown() {
    const now = Date.now();
    if (!this.rtt || !this.tickMs) return;
    if (this.rtt <= this.tickMs * 1.2) return;
    if (now - this.lastSpeedAt < 10000) return;
    const want = Math.max(300, Math.min(900, Math.round(this.rtt * 1.25)));
    if (want <= this.tickMs) return;
    this.lastSpeedAt = now;
    this.send({ t: 'speed', ms: want });
    this.log(`网络延迟 ${this.rtt}ms 大于 ${this.tickMs}ms/拍，把房间放慢到 ${want}ms/拍`);
  }

  stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.running = false;
    try { this.ws && this.ws.close(); } catch {}
    this.log('已停止');
  }

  status() {
    return {
      running: this.running,
      base: this.base,
      user: this.user,
      room: this.roomName,
      score: this.score,
      best: this.bestScore,
      len: this.len,
      alive: this.alive,
      deaths: this.deaths,
      decisions: this.decisions,
      lag: this.driver ? Math.round(this.driver.lag * 10) / 10 : 0,
      rtt: this.rtt,
      tickMs: this.tickMs,
      cols: this.cols,
      rows: this.rows,
      logs: this.logs.slice(-40)
    };
  }
}

// ---------------- HTTP ----------------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) break;
  }
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    const file = path.join(PUBLIC, 'index.html');
    const html = fs.readFileSync(file, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (url === '/api/start' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      if (session) session.stop();
      session = new Session(body);
      await session.start();
      return sendJSON(res, 200, { ok: true, status: session.status() });
    } catch (e) {
      session = null;
      return sendJSON(res, 400, { ok: false, msg: String(e.message || e) });
    }
  }

  if (url === '/api/stop' && req.method === 'POST') {
    if (session) session.stop();
    return sendJSON(res, 200, { ok: true });
  }

  if (url === '/api/status') {
    return sendJSON(res, 200, { ok: true, status: session ? session.status() : null });
  }

  sendJSON(res, 404, { ok: false, msg: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  🐍 本地开挂面板已启动');
  console.log('  打开： http://127.0.0.1:' + PORT);
  console.log('  Ctrl+C 停止');
  console.log('');
});
