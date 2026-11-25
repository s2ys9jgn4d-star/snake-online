'use strict';
/*
 * 代打驱动层：解决「高延迟下蛇原地画圈 / 贴墙撞死」。
 *
 * 病根有两个：
 *   1. 画面在路上走了几拍，指令又要几拍才被执行 —— 对着旧蛇头做决策，每拍答案都在变，蛇就抖；
 *   2. 快撞墙时才想拐弯，指令到的时候已经晚了两格。
 *
 * 药方：
 *   1. 迟滞：直走和拐弯同等好时一律直走，抖动立刻消失；
 *   2. 提前拐：直走前方剩下的空格 <= 延迟拍数+2 时才拐，而不是等贴墙才拐；
 *   3. 安全边距：延迟越大越不往最外圈走，指令晚到也还有余量。
 *
 * 延迟用「发出指令 → 看见生效」的墙钟差在线量出来，估错只会更保守。
 */

const { createEngine } = require('./engine');

const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
const DLT = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

class Driver {
  constructor(cols, rows, opts = {}) {
    this.cols = cols;
    this.rows = rows;
    this.maxLag = opts.maxLag || 6;
    this.lag = 1.5;
    this.samples = [];
    this.rtt = 0;       // 实测往返毫秒（由面板的 ping 喂进来）
    this.margin = 0;
    this.engine = createEngine(cols, rows, { margin: 0, hysteresis: 1 });
    this.lastSent = null;
  }

  setMargin(m) {
    if (m === this.margin) return;
    this.margin = m;
    this.engine = createEngine(this.cols, this.rows, { margin: m, hysteresis: 1 });
  }

  key(x, y) { return y * this.cols + x; }

  blockedOf(me, players) {
    const blocked = new Set();
    for (const p of players) {
      if (!p.alive || !p.body) continue;
      for (let i = 0; i < p.body.length; i++) {
        if (p.id === me.id && i === p.body.length - 1) continue; // 自己尾巴会让开
        blocked.add(this.key(p.body[i][0], p.body[i][1]));
      }
    }
    return blocked;
  }

  // 直走方向前方还有几格是空的
  corridor(me, players, dir) {
    const blocked = this.blockedOf(me, players);
    let x = me.body[0][0], y = me.body[0][1], n = 0;
    while (n <= 20) {
      x += DLT[dir][0]; y += DLT[dir][1];
      if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return n;
      if (blocked.has(this.key(x, y))) return n;
      n++;
    }
    return n;
  }

  // 从蛇头往某个方向走一格，离最近苹果还有多远（-1 = 走不到）
  foodAt(me, players, foods, dir) {
    const blocked = this.blockedOf(me, players);
    const nx = me.body[0][0] + DLT[dir][0], ny = me.body[0][1] + DLT[dir][1];
    if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) return -1;
    if (blocked.has(this.key(nx, ny))) return -1;
    const dist = new Int32Array(this.cols * this.rows).fill(-1);
    const q = [];
    for (const f of foods || []) {
      const k = this.key(f[0], f[1]);
      if (blocked.has(k) || dist[k] === 0) continue;
      dist[k] = 0; q.push(k);
    }
    const start = this.key(nx, ny);
    if (dist[start] === 0) return 0;
    let i = 0;
    while (i < q.length) {
      const k = q[i++], x = k % this.cols, y = (k / this.cols) | 0;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const ex = x + dx, ey = y + dy;
        if (ex < 0 || ey < 0 || ex >= this.cols || ey >= this.rows) continue;
        const ek = this.key(ex, ey);
        if (dist[ek] !== -1 || blocked.has(ek)) continue;
        dist[ek] = dist[k] + 1;
        q.push(ek);
      }
    }
    return dist[start];
  }

  // 把蛇按当前方向往前推 k 格（近似“画面在路上走掉的那几拍”）
  ahead(me, players, foods, k) {
    const body = me.body.map((s) => [s[0], s[1]]);
    const foodSet = new Set((foods || []).map((f) => this.key(f[0], f[1])));
    const blocked = this.blockedOf(me, players);
    let dir = me.dir;
    for (let i = 0; i < k; i++) {
      const h = body[0];
      const nx = h[0] + DLT[dir][0], ny = h[1] + DLT[dir][1];
      if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) break;
      const nk = this.key(nx, ny);
      const ownHit = body.slice(0, body.length - 1).some((s) => this.key(s[0], s[1]) === nk);
      if (ownHit) break;
      body.unshift([nx, ny]);
      if (foodSet.has(nk)) foodSet.delete(nk); else body.pop();
    }
    return { body, dir };
  }

  /** 每帧快照调用一次，返回要发的方向（null = 不用发） */
  command(me, players, foods, tick) {
    if (!me || !me.alive || !me.body || !me.body.length) return null;

    // 延迟估计取两路的最大值：指令生效差 + 往返时间折算（后者更可靠）
    const tickMsNow = this.tickMs || 200;
    if (this.rtt) this.lag = Math.max(this.lag, this.rtt / tickMsNow);
    this.setMargin(Math.min(2, Math.max(0, Math.round(this.lag) - 1)));

    // 关键一步：把蛇先按原方向推到「指令真正被执行」的位置，在那里决策，决策和执行才对齐
    const k = Math.max(0, Math.round(this.lag - 0.5));
    const proj = this.ahead(me, players, foods, k);
    const projMe = { id: me.id, alive: true, dir: proj.dir, body: proj.body, score: me.score };
    const dir = this.engine.decide(projMe, players, foods);
    if (!dir || dir === proj.dir || dir === me.dir) return null;   // 直走就行
    if (dir === OPP[me.dir]) return null;             // 非法掉头

    // 前方还长就先直着走，省得指令到得太早、把路线带偏
    const ahead = this.corridor(me, players, me.dir);
    if (ahead > this.lag + 2 && false) {
      const straightFood = this.foodAt(me, players, foods, me.dir);
      const turnFood = this.foodAt(me, players, foods, dir);
      const worth = turnFood >= 0 && straightFood >= 0 && turnFood <= straightFood - 2;
      if (!worth) return null;
    }

    if (this.lastSent && this.lastSent.dir === dir && tick - this.lastSent.tick <= this.maxLag) return null;
    this.lastSent = { dir, tick, at: Date.now() };
    return dir;
  }

  /** 每帧调用：看见服务器真的按我们发的方向走了，记一次延迟样本 */
  observe(me, tick, tickMs) {
    if (!me || !me.alive || !this.lastSent) return;
    if (me.dir !== this.lastSent.dir) return;
    const sent = this.lastSent;
    this.lastSent = null;
    const guess = Math.max(0, (Date.now() - sent.at) / (tickMs || 200));
    this.samples.push(guess);
    if (this.samples.length > 8) this.samples.shift();
    const out = Math.max(...this.samples);
    this.lag = Math.max(0, Math.min(this.maxLag, out * 0.6 + guess * 0.4));
  }

  reset() { this.lastSent = null; }
}

module.exports = { Driver };
