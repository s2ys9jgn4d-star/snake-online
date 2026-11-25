'use strict';
/*
 * 自动走位内核 —— 从 bot/snake-bot.js v3 抽出来的
 *
 * 思路（也是它几乎不会死的原因）：
 *   1. 多源 BFS 算出每格到最近苹果的步数，优先抢最近的
 *   2. 走完这一步，还能不能顺着空位摸到自己的尾巴？
 *      能摸到 = 身体和尾巴之间还有通路，没把自己关死（尾巴每步都会挪开）
 *   3. 别人蛇头所在格 + 四周一圈都算危险格，能不去就不去
 *   4. 全都不安全时，退而求其次选空地最多的方向
 */

const REVERSE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const DELTA = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const DIRS = ['up', 'down', 'left', 'right'];
const NB = [[0, -1], [0, 1], [-1, 0], [1, 0]];

function createEngine(COLS, ROWS, opts = {}) {
  const MARGIN = Math.max(0, Math.min(2, opts.margin || 0));      // 贴墙的安全边距
  const HYS = Math.max(0, opts.hysteresis || 0);                 // 迟滞：差不多好就别拐弯
  const NCELL = COLS * ROWS;
  const keyOf = (x, y) => y * COLS + x;
  const inside = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;

  // 预分配缓冲，避免每帧 GC
  const bufFood = new Int16Array(NCELL);
  const bufTail = new Int16Array(NCELL);
  const bufQ = new Int32Array(NCELL);
  const bufArea = new Int32Array(NCELL);

  function bfs(blocked, sx, sy, dist) {
    dist.fill(-1);
    const s = keyOf(sx, sy);
    if (blocked.has(s)) return dist;
    dist[s] = 0;
    let qs = 0, qe = 0;
    bufQ[qe++] = s;
    while (qs < qe) {
      const k = bufQ[qs++], x = k % COLS, y = (k / COLS) | 0;
      for (let i = 0; i < 4; i++) {
        const nx = x + NB[i][0], ny = y + NB[i][1];
        if (!inside(nx, ny)) continue;
        const nk = keyOf(nx, ny);
        if (dist[nk] !== -1 || blocked.has(nk)) continue;
        dist[nk] = dist[k] + 1;
        bufQ[qe++] = nk;
      }
    }
    return dist;
  }

  function foodField(blocked, foods, dist) {
    dist.fill(-1);
    let qs = 0, qe = 0;
    for (const f of foods) {
      const k = keyOf(f[0], f[1]);
      if (blocked.has(k) || dist[k] === 0) continue;
      dist[k] = 0;
      bufQ[qe++] = k;
    }
    while (qs < qe) {
      const k = bufQ[qs++], x = k % COLS, y = (k / COLS) | 0;
      for (let i = 0; i < 4; i++) {
        const nx = x + NB[i][0], ny = y + NB[i][1];
        if (!inside(nx, ny)) continue;
        const nk = keyOf(nx, ny);
        if (dist[nk] !== -1 || blocked.has(nk)) continue;
        dist[nk] = dist[k] + 1;
        bufQ[qe++] = nk;
      }
    }
    return dist;
  }

  // 从某格出发能连成一片的空地有多少（数到 cap 就停）
  function areaFrom(start, blocked, cap) {
    if (blocked.has(start)) return 0;
    const seen = bufArea;
    for (let i = 0; i < NCELL; i++) seen[i] = 0;
    let qs = 0, qe = 0, count = 0;
    seen[start] = 1;
    bufQ[qe++] = start;
    while (qs < qe) {
      const k = bufQ[qs++], x = k % COLS, y = (k / COLS) | 0;
      count++;
      if (count >= cap) return count;
      for (let i = 0; i < 4; i++) {
        const nx = x + NB[i][0], ny = y + NB[i][1];
        if (!inside(nx, ny)) continue;
        const nk = keyOf(nx, ny);
        if (seen[nk] || blocked.has(nk)) continue;
        seen[nk] = 1;
        bufQ[qe++] = nk;
      }
    }
    return count;
  }

  function decide(me, players, foods) {
    if (!me || !me.alive || !me.body || !me.body.length) return null;
    const head = me.body[0];
    const len = me.body.length;

    // 障碍：所有蛇身。只有自己的尾巴一定会让开，别人尾巴可能因为吃苹果不动，一律当墙
    const blocked = new Set();
    for (const p of players) {
      if (!p.alive || !p.body) continue;
      const isMe = p.id === me.id;
      for (let i = 0; i < p.body.length; i++) {
        if (isMe && i === p.body.length - 1) continue;
        blocked.add(keyOf(p.body[i][0], p.body[i][1]));
      }
    }

    const fdist = foodField(blocked, foods || [], bufFood);
    const tail = me.body[me.body.length - 1];
    const tdist = bfs(blocked, tail[0], tail[1], bufTail);

    // 危险格：别人蛇头 + 它四周一圈（头对头是两条一起死）
    const danger = new Set();
    for (const p of players) {
      if (!p.alive || p.id === me.id || !p.body || !p.body.length) continue;
      const ex = p.body[0][0], ey = p.body[0][1];
      danger.add(keyOf(ex, ey));
      for (let i = 0; i < 4; i++) {
        const nx = ex + NB[i][0], ny = ey + NB[i][1];
        if (inside(nx, ny)) danger.add(keyOf(nx, ny));
      }
    }

    const cands = [];
    for (const d of DIRS) {
      if (d === REVERSE[me.dir]) continue;
      const nx = head[0] + DELTA[d][0], ny = head[1] + DELTA[d][1];
      if (!inside(nx, ny)) continue;
      const k = keyOf(nx, ny);
      if (blocked.has(k)) continue;
      const edge = nx < MARGIN || ny < MARGIN || nx >= COLS - MARGIN || ny >= ROWS - MARGIN;
      cands.push({ edge,
        d,
        safe: tdist[k] >= 0,
        headRisk: danger.has(k) ? 1 : 0,
        food: fdist[k] >= 0 ? fdist[k] : 999,
        slack: tdist[k],
        area: areaFrom(k, blocked, len + 40)
      });
    }
    if (!cands.length) return null;

    let pool = cands.filter((c) => c.safe && !c.headRisk && !c.edge);
    if (!pool.length) pool = cands.filter((c) => c.safe && !c.headRisk);
    if (!pool.length) pool = cands.filter((c) => c.safe);
    if (!pool.length) pool = cands;

    pool.sort((a, b) => {
      if (a.food !== b.food) return a.food - b.food;
      if (a.area !== b.area) return b.area - a.area;
      return a.headRisk - b.headRisk;
    });
    // 迟滞：直着走不比最优差太多就不拐，免得高延迟下每拍来回抖
    if (HYS && pool.length > 1) {
      const straight = pool.find((c) => c.d === me.dir);
      if (straight && straight.food <= pool[0].food + (HYS - 1)) return straight.d; // HYS=1 → 只认平手
    }
    return pool[0].d;
  }

  return { decide };
}

module.exports = { createEngine };
