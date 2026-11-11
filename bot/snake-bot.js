// 代打机器人 v3：BFS 抢食 + 尾巴可达安全检查
const BASE = process.env.BOT_BASE || 'http://localhost:8180';
const WS_URL = BASE.replace(/^http/, 'ws');
const USER = process.env.BOT_USER || '豆包';   // 多开时用不同账号，否则会互相顶下线
const PASS = process.env.BOT_PASS || 'doubao2026';
const ROOM_NAME = process.env.BOT_ROOM_NAME || '豆包代打';
// 进房策略：bot = 只进豆包自己的房间（默认，不去打扰真人）；any = 进人最多的房间；never = 永远自己建房
const JOIN_MODE = process.env.BOT_JOIN || 'bot';
const isBotRoom = name => name === ROOM_NAME || name.startsWith('豆包');
const COLS = 42, ROWS = 30;
const SAFETY = 1; // 额外安全余量（格）

// —— 构造覆盖全盘的哈密顿环：第 0 行当“桥”，其余蛇形 ——
const CYC = [];
for (let x = 0; x < COLS; x++) {
  if (x % 2 === 0) { for (let y = 1; y < ROWS; y++) CYC.push([x, y]); }
  else { for (let y = ROWS - 1; y >= 1; y--) CYC.push([x, y]); }
}
CYC.push([COLS - 1, 0]);
for (let x = COLS - 2; x >= 0; x--) CYC.push([x, 0]);
const N = CYC.length;
const IDX = new Map(CYC.map((c, i) => [c[1] * COLS + c[0], i]));
const idxOf = (x, y) => IDX.has(y * COLS + x) ? IDX.get(y * COLS + x) : -1;
const fwd = (from, to) => (to - from + N) % N; // 沿环前进距离

const REVERSE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const DELTA = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const inside = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;

let players = [], foods = [], myId = null, seq = 0, wasAlive = true;
let bestScore = 0, deaths = 0, rounds = 0, lastSent = null;
const t0 = Date.now();
const TIME_LIMIT = Number(process.env.BOT_SECONDS || 120) * 1000;
const me = () => players.find(p => p.id === myId) || null;

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, ...j };
}

let ws;
const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function sendDir(dir) {
  const m = me();
  if (!m || !m.alive) return;
  // 只挡“当前方向”和“反向”，重复发送同方向是安全的（服务器会忽略）
  if (dir === m.dir || dir === REVERSE[m.dir]) return;
  send({ t: 'dir', dir, seq: ++seq });
}

// ============================================================
//  v3 决策：BFS 抢食 + 可达空间安全检查 + 哈密顿环兜底
// ============================================================
const NB = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const keyOf = (x, y) => y * COLS + x;

// 障碍格：蛇身。只有“自己的尾巴”一定会让开，别人的尾巴可能因为吃到食物而不动，
// 所以别人的尾巴照样当墙，宁可绕一下也别赌。
function buildBlocked() {
  const blocked = new Set();
  for (const p of players) {
    if (!p.alive || !p.body) continue;
    const isMe = p.id === myId;
    for (let i = 0; i < p.body.length; i++) {
      if (isMe && i === p.body.length - 1) continue;
      blocked.add(keyOf(p.body[i][0], p.body[i][1]));
    }
  }
  return blocked;
}

// 从某格出发的 BFS，返回步数数组（-1 = 走不到）
// 预分配缓冲区：每步都 new 数组会触发 GC，50ms 步速下偶发的 GC 停顿就是致命的
const NCELL = COLS * ROWS;
const BUF_FOOD = new Int16Array(NCELL);
const BUF_TAIL = new Int16Array(NCELL);
const BUF_Q = new Int32Array(NCELL);

function bfsFrom(sx, sy, blocked, dist) {
  dist.fill(-1);
  const s = keyOf(sx, sy);
  if (blocked.has(s)) return dist;
  dist[s] = 0;
  let qs = 0, qe = 0;
  BUF_Q[qe++] = s;
  while (qs < qe) {
    const k = BUF_Q[qs++], x = k % COLS, y = (k / COLS) | 0;
    for (const [dx, dy] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const nk = ny * COLS + nx;
      if (dist[nk] !== -1 || blocked.has(nk)) continue;
      dist[nk] = dist[k] + 1; BUF_Q[qe++] = nk;
    }
  }
  return dist;
}

// 多源 BFS：算出每个格子到最近食物要走几步（-1 表示走不到）
function foodField(blocked, dist) {
  dist.fill(-1);
  let qs = 0, qe = 0;
  for (const [fx, fy] of foods) {
    const k = keyOf(fx, fy);
    if (blocked.has(k) || dist[k] === 0) continue;
    dist[k] = 0; BUF_Q[qe++] = k;
  }
  while (qs < qe) {
    const k = BUF_Q[qs++], x = k % COLS, y = (k / COLS) | 0;
    for (const [dx, dy] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const nk = ny * COLS + nx;
      if (dist[nk] !== -1 || blocked.has(nk)) continue;
      dist[nk] = dist[k] + 1; BUF_Q[qe++] = nk;
    }
  }
  return dist;
}

const stat = { n: 0, sum: 0, max: 0 };
let lastHead = '', lastEnemyHeads = [];
function think() {
  const t0 = performance.now();
  decide();
  const dt = performance.now() - t0;
  stat.n++; stat.sum += dt; if (dt > stat.max) stat.max = dt;
}

function decide() {
  const m = me();
  if (!m) return;

  if (!m.alive) {
    if (m.score > bestScore) bestScore = m.score;
    if (wasAlive) {
      wasAlive = false; deaths++;
      if (process.env.BOT_DEBUG) {
        console.log(`[死亡] ${USER} 上一步头=(${lastHead}) 敌人头=${lastEnemyHeads.join(' ') || '无'}`);
      }
      setTimeout(() => { send({ t: 'respawn' }); rounds++; }, 600);
    }
    return;
  }
  wasAlive = true;
  if (m.score > bestScore) bestScore = m.score;
  if (!m.body || !m.body.length) return;

  const head = m.body[0], len = m.body.length;
  lastHead = head.join(',');
  lastEnemyHeads = players
    .filter(p => p.alive && p.id !== myId && p.body && p.body.length)
    .map(p => '(' + p.body[0].join(',') + ')');
  const tail = m.body[m.body.length - 1];
  const blocked = buildBlocked();
  const fdist = foodField(blocked, BUF_FOOD);
  // 核心安全线：走完这一步，还能不能摸到自己的尾巴？
  // 能摸到 = 身体和尾巴之间还有通路，不会被自己围死（尾巴每步都会让开）
  const tdist = bfsFrom(tail[0], tail[1], blocked, BUF_TAIL);

  // 危险格：别人蛇头所在格 + 它四周一圈（它下一步也可能转进来 → 头对头）
  const danger = new Set();
  for (const p of players) {
    if (!p.alive || p.id === myId || !p.body || !p.body.length) continue;
    const [ex, ey] = p.body[0];
    danger.add(keyOf(ex, ey));
    for (const [dx, dy] of NB) {
      const nx = ex + dx, ny = ey + dy;
      if (inside(nx, ny)) danger.add(keyOf(nx, ny));
    }
  }

  const cands = [];
  for (const d of ['up', 'down', 'left', 'right']) {
    if (d === REVERSE[m.dir]) continue;                 // 不能 180° 掉头
    const nx = head[0] + DELTA[d][0], ny = head[1] + DELTA[d][1];
    if (!inside(nx, ny)) continue;
    const k = keyOf(nx, ny);
    if (blocked.has(k)) continue;                       // 撞自己或撞别人
    const slack = tdist[k];                             // 到尾巴的距离，-1 = 摸不到
    const safe = slack >= 0;
    const fd = fdist[k] >= 0 ? fdist[k] : 999;          // 该格到最近食物的步数
    cands.push({ d, safe, headRisk: danger.has(k) ? 1 : 0, food: fd, slack });
  }
  if (!cands.length) return;

  // 优先级：安全且不撞头 > 安全 > 全部可行
  let pool = cands.filter(c => c.safe && !c.headRisk);
  if (!pool.length) pool = cands.filter(c => c.safe);
  if (!pool.length) pool = cands;

  if (pool === cands) {
    // 已经无路可走（被围死）：沿哈密顿环往前，理论上最安全
    const hI = idxOf(head[0], head[1]);
    let best = null;
    for (const c of cands) {
      const i = idxOf(head[0] + DELTA[c.d][0], head[1] + DELTA[c.d][1]);
      if (i < 0) continue;
      const step = fwd(hI, i);
      if (!best || step < best.step) best = { d: c.d, step };
    }
    if (best) return sendDir(best.d);
  }

  pool.sort((a, b) => {
    if (a.food !== b.food) return a.food - b.food;     // 先选离食物最近的
    if (a.slack !== b.slack) return b.slack - a.slack; // 其次离尾巴更远（空间更宽松）
    return a.headRisk - b.headRisk;
  });
  sendDir(pool[0].d);
}

function onState(msg) {
  players = msg.players || [];
  foods = msg.foods || [];
  if (myId == null) {
    const cand = players.filter(p => p.name === USER);
    if (cand.length) myId = cand[cand.length - 1].id;
  }
  think();
}

async function main() {
  const reg = await post('/api/register', { u: USER, p: PASS });
  if (reg.status === 409) console.log('账号已存在，直接登录');
  const li = await post('/api/login', { u: USER, p: PASS });
  if (!li.token) { console.error('登录失败', li); process.exit(1); }
  console.log('登录成功 | 环长', N, '格');

  ws = new WebSocket(WS_URL);
  let roomLocked = false;
  const pingTimer = setInterval(() => send({ t: 'ping', ts: Date.now() }), 2000);

  ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: li.token }));
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'auth_ok') { send({ t: 'list_rooms' }); return; }
    if (msg.t === 'rooms') {
      if (roomLocked) return;
      roomLocked = true;
      const list = msg.items || [];
      console.log('房间:', list.map(r => `${r.name}(${r.count}/${r.max})`).join(' | ') || '无');
      const open = list.filter(r => !r.hasPwd);
      // 默认只进豆包自己的房间：别跑去把真人的房间屠了
      const pick = JOIN_MODE === 'never' ? null
        : JOIN_MODE === 'any' ? open.sort((a, b) => b.count - a.count)[0]
        : open.filter(r => isBotRoom(r.name)).sort((a, b) => b.count - a.count)[0];
      if (pick) { console.log('加入', pick.name); send({ t: 'join_room', id: pick.id }); }
      else { console.log('自己建房', ROOM_NAME); send({ t: 'create_room', name: ROOM_NAME }); }
      return;
    }
    if (msg.t === 'joined_room') {
      // 自己建的房间就是房主，可以把速度调快（服务端限制最慢 500ms / 最快 50ms）
      if (process.env.BOT_SPEED) send({ t: 'speed', ms: Number(process.env.BOT_SPEED) });
      return;
    }
    if (msg.t === 'state') { onState(msg); return; }
    if (msg.t === 'sys') { console.log('[系统]', msg.msg); return; }
  };
  ws.onclose = () => { clearInterval(pingTimer); console.log('连接关闭'); };

  let ending = false;
  ws.onerror = e => { if (!ending) console.log('连接错误', e.message || e); };

  setTimeout(() => {
    ending = true;
    const m = me();
    if (m && m.score > bestScore) bestScore = m.score;
    console.log(`\n== 结束: 最高分 ${bestScore}，死亡 ${deaths} 次，在场 ${rounds} 次，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
    if (process.env.BOT_DEBUG && stat.n) {
      console.log(`== 每步计算耗时: 平均 ${(stat.sum / stat.n).toFixed(2)}ms，最慢 ${stat.max.toFixed(2)}ms（共 ${stat.n} 步）`);
    }
    try { ws.close(); } catch {}
    setTimeout(() => process.exit(0), 500);
  }, TIME_LIMIT);
}

main();
