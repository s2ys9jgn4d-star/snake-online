'use strict';
/*
 * 派派 AI —— 来自哔哩哔哩《训练贪吃蛇AI死了1891次，它竟然学会了……》
 * 原版：https://github.com/wangyc685/paipai-lab（ep11-ai-snake/snake_ai.py）
 *
 * 原版的脑子就是一个字典：账本[看到的情况] = [直走值几分, 左转值几分, 右转值几分]，
 * 靠 Q 学习（时间差分）一点点把分数往真实收益挪。
 * 这里把「规则三」（吃到苹果加分 + 能数空地）搬到 42×30 的联机棋盘上：
 *   · 训练时是空棋盘单蛇，和视频里一样
 *   · 上场时把「别的蛇的身体」也算成墙，再叠一层安全网
 *     （不许 180° 掉头、不许直接撞、落脚后空间太小就重罚）
 * 所以它不是无敌的，而是一条会吃苹果、偶尔也会把自己困住的蛇。
 *
 * 记法：账本的键是 44 bit 的整数
 *   danger(3) | dir(2) | 苹果上下左右(4) | 空地够不够转(3)
 * 动作：0 直走 / 1 左转 / 2 右转
 */

const IDX = { up: 0, right: 1, down: 2, left: 3 };
const VEC = [ { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 } ];
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const NAMES = ['up', 'right', 'down', 'left'];

// 走神概率：0 = 每拍都是最优解（人打不过），0.08 = 大约每 12 拍犯一次傻
function SLACK(){
  const v = Number(process.env.PAIPAI_SLACK);
  if (!Number.isFinite(v)) return 0.08;
  return Math.min(0.6, Math.max(0, v));
}

const turn = (dirIdx, act) => (act === 0 ? dirIdx : act === 1 ? (dirIdx - 1 + 4) % 4 : (dirIdx + 1) % 4);

// —— 空地数量：从这个格子出发能连成一片的空格有多少（数到 cap 就提前收工）——
function areaFrom(start, blocked, cap, COLS, ROWS){
  if (blocked.has(start)) return 0;
  const seen = new Set([start]);
  const q = [start];
  for (let qi = 0; qi < q.length; qi++){
    const k = q[qi], x = k % COLS, y = (k / COLS) | 0;
    for (let i = 0; i < 4; i++){
      const nx = x + VEC[i].x, ny = y + VEC[i].y;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const nk = ny * COLS + nx;
      if (seen.has(nk) || blocked.has(nk)) continue;
      seen.add(nk);
      q.push(nk);
      if (seen.size >= cap) return seen.size;
    }
  }
  return seen.size;
}

// —— 状态编码：danger / 朝向 / 苹果方向 / 三方向空地够不够 ——
function encode(head, dirIdx, foods, blocked, bodyLen, COLS, ROWS){
  let danger = 0;
  let space = 0;
  for (let act = 0; act < 3; act++){
    const d = turn(dirIdx, act);
    const nx = head.x + VEC[d].x, ny = head.y + VEC[d].y;
    let isDanger = 1;
    if (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && !blocked.has(ny * COLS + nx)){
      isDanger = 0;
      // 落脚之后还能不能活动开（够不够转身）
      if (areaFrom(ny * COLS + nx, blocked, bodyLen + 2, COLS, ROWS) >= bodyLen + 1) space |= 1 << act;
    }
    danger |= isDanger << act;
  }

  // 最近的苹果在哪个方向
  let fx = head.x, fy = head.y, best = Infinity;
  for (const f of foods){
    const dd = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
    if (dd < best){ best = dd; fx = f.x; fy = f.y; }
  }
  let food = 0;
  if (best < Infinity){
    food = (fy < head.y ? 1 : 0) | (fx > head.x ? 2 : 0) | (fy > head.y ? 4 : 0) | (fx < head.x ? 8 : 0);
  }
  return ((danger & 7) << 11) | ((dirIdx & 3) << 9) | ((food & 15) << 5) | (space & 7);
}

// ============================================================
//  训练：空棋盘单蛇，跑一批对局，边玩边记账
// ============================================================
function train(opts){
  const o = Object.assign({
    episodes: 1200, maxSteps: 400, alpha: 0.1, gamma: 0.9,
    eps0: 1.0, epsDecay: 0.995, epsMin: 0.02, seed: 20261125,
    COLS: 42, ROWS: 30
  }, opts || {});

  const { COLS, ROWS } = o;
  let seed = o.seed;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ri = (n) => Math.floor(rnd() * n) * 1;
  const pick = (arr) => arr[ri(arr.length)];

  const table = Object.create(null);
  let deaths = 0, apples = 0, stepsAll = 0;

  for (let ep = 0; ep < o.episodes; ep++){
    const eps = Math.max(o.epsMin, o.eps0 * Math.pow(o.epsDecay, ep));

    // 初始：三条长，随机落在棋盘中间偏左
    let body = [];
    const cy = 6 + ri(ROWS - 12);
    for (let i = 0; i < 3; i++) body.push({ x: 8 + 2 - i, y: cy });
    let dirIdx = 1; // 朝右
    let foods = [{ x: 8 + 2 + 5 + ri(20), y: 6 + ri(ROWS - 12) }];
    let len = body.length;

    const blocked = () => {
      const set = new Set();
      for (let i = 0; i < body.length - 1; i++) set.add(body[i].y * COLS + body[i].x);
      return set;
    };

    let key = encode(body[0], dirIdx, foods, blocked(), len, COLS, ROWS);
    let steps = 0;

    while (true){
      let qv = table[key];
      if (!qv) qv = table[key] = [0, 0, 0];

      let act;
      if (rnd() < eps) act = ri(3);
      else {
        act = 0;
        if (qv[1] > qv[act]) act = 1;
        if (qv[2] > qv[act]) act = 2;
      }

      const d = turn(dirIdx, act);
      dirIdx = d;
      const nh = { x: body[0].x + VEC[d].x, y: body[0].y + VEC[d].y };
      steps++;

      const wall = nh.x < 0 || nh.y < 0 || nh.x >= COLS || nh.y >= ROWS;
      const selfBite = !wall && blocked().has(nh.y * COLS + nh.x);
      let reward = 0;
      let over = false;

      if (wall || selfBite){
        reward = -10;
        over = true;
      } else {
        body.unshift(nh);
        const ate = foods.some((f) => f.x === nh.x && f.y === nh.y);
        if (ate){
          reward = 10;
          apples++;
          len = body.length;
          // 吃完放一个新苹果（只在空格子上）
          for (let t = 0; t < 100; t++){
            const nx = ri(COLS), ny = ri(ROWS);
            if (!body.some((s) => s.x === nx && s.y === ny)){ foods = [{ x: nx, y: ny }]; break; }
          }
        } else {
          body.pop();
        }
      }

      const nextKey = over ? null : encode(body[0], dirIdx, foods, blocked(), len, COLS, ROWS);
      let nextMax = 0;
      if (!over){
        let nv = table[nextKey];
        if (!nv) nv = table[nextKey] = [0, 0, 0];
        nextMax = Math.max(nv[0], nv[1], nv[2]);
      }
      const target = reward + o.gamma * nextMax;
      qv[act] += o.alpha * (target - qv[act]);

      if (over){ deaths++; break; }
      if (steps >= o.maxSteps) break;
      key = nextKey;
    }
    stepsAll += steps;
  }

  return {
    table,
    stats: {
      episodes: o.episodes,
      states: Object.keys(table).length,
      deaths,
      apples,
      avgSteps: +(stepsAll / o.episodes).toFixed(1),
      avgApples: +(apples / o.episodes).toFixed(2),
      COLS, ROWS
    }
  };
}

// 表 → 紧凑数组，便于存 json
function pack(table){
  const keys = Object.keys(table);
  return { v: 1, keys: keys.map(Number), vals: keys.map((k) => table[k].map((x) => +x.toFixed(3))) };
}
function unpack(obj){
  const table = Object.create(null);
  if (!obj || !obj.keys) return table;
  for (let i = 0; i < obj.keys.length; i++) table[obj.keys[i]] = obj.vals[i];
  return table;
}

// ============================================================
//  上场决策：算好自己能走的三个方向，再照账本挑最值的
// ============================================================
function decide(room, p, COLS, ROWS, table){
  if (!p || !p.body || !p.body.length) return null;
  const head = p.body[0];
  const dirIdx = IDX[p.dir] != null ? IDX[p.dir] : 1;

  // 所有蛇的身体都当墙。尾巴虽然下一步会挪开，但“这步吃到苹果就不挪”，
  // 为了不赌运气，一律算死墙，宁可绕一步。
  const blocked = new Set();
  for (const q of room.players.values()){
    if (!q.alive || !q.body || !q.body.length) continue;
    for (const s of q.body) blocked.add(s.y * COLS + s.x);
  }

  const foods = room.foods && room.foods.length ? room.foods : [];
  const len = p.body.length;
  const key = encode(head, dirIdx, foods, blocked, len, COLS, ROWS);
  const qv = table[key] || null;

  const candidates = [];
  for (let act = 0; act < 3; act++){
    const d = turn(dirIdx, act);
    if (NAMES[d] === OPPOSITE[p.dir]) continue;
    const nx = head.x + VEC[d].x, ny = head.y + VEC[d].y;
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
    const nk = ny * COLS + nx;
    if (blocked.has(nk)) continue;
    const area = areaFrom(nk, blocked, len + 60, COLS, ROWS);
    let score = qv ? qv[act] * 10 : 0;
    if (area < len + 1) score -= 500;            // 会把自己关死
    else if (area < len + 6) score -= 30;        // 太挤，别往里钻
    if (act === 0) score += 0.5;                 // 平手优先直行，看着不像抽风
    candidates.push({ dir: NAMES[d], score, area });
  }
  if (!candidates.length) return null;

  // 走神：偶尔不走最优解，随便挑一个“不至于自杀”的方向。
  // 这是给人留活路的关键——没有它，AI 每一拍都是满分操作，人根本追不上。
  const slack = SLACK();
  if (slack > 0 && candidates.length > 1 && Math.random() < slack){
    const safe = candidates.filter((c) => c.area >= len + 1);
    const pool = safe.length > 1 ? safe : candidates;
    return pool[(Math.random() * pool.length) | 0].dir;
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].dir;
}

module.exports = { train, pack, unpack, decide, encode, areaFrom };
