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
//  四个难度：难度不改速度，只改它“想得有多好”
//  slack    走神概率（越小越强）
//  chase    愿意追多远的苹果（小 = 懒得跑，只捡眼前的）
//  hesitate 慢半拍概率（照着原方向再走一步）
//  hunt     会不会主动封路（简单/普通过日子，困难/噩梦真的会杀）
//    range  多近才动杀心（格）
//    wExit  把你出口数从 4 压到 1 值多少分
//    wCross 抢到你前方第二格、让身子横在你脸上值多少分
// ============================================================
const DIFFS = {
  easy:      { slack: 0.32, chase: 6,  hesitate: 0.25, hunt: null },
  normal:    { slack: 0.14, chase: 12, hesitate: 0.10, hunt: null },
  hard:      { slack: 0.04, chase: 99, hesitate: 0.03, hunt: { range: 6, wExit: 20, wCross: 45, wChase: 7 } },
  nightmare: { slack: 0,    chase: 99, hesitate: 0,    hunt: { range: 8, wExit: 26, wCross: 60, wChase: 7 } }
};
function profileOf(diff){
  const d = DIFFS[String(diff || '')] || DIFFS.normal;
  return Object.assign({}, d);
}

// ============================================================
//  上场决策：算好自己能走的三个方向，再照账本挑最值的
// ============================================================
function decide(room, p, COLS, ROWS, table, profile){
  if (!p || !p.body || !p.body.length) return null;
  const pf = Object.assign({ slack: SLACK(), chase: 99, hesitate: 0, hunt: false }, profile || {});
  const head = p.body[0];
  const dirIdx = IDX[p.dir] != null ? IDX[p.dir] : 1;

  // 所有蛇的身体都当墙。尾巴虽然下一步会挪开，但“这步吃到苹果就不挪”，
  // 为了不赌运气，一律算死墙，宁可绕一步。
  const blocked = new Set();
  for (const q of room.players.values()){
    if (!q.alive || !q.body || !q.body.length) continue;
    for (const s of q.body) blocked.add(s.y * COLS + s.x);
  }

  // 难度低的 AI 懒得跑远路，只看得见身边那几个苹果
  let foods = room.foods && room.foods.length ? room.foods : [];
  if (pf.chase < 90 && foods.length){
    const near = foods.filter((f) => Math.abs(f.x - head.x) + Math.abs(f.y - head.y) <= pf.chase);
    if (near.length) foods = near;
  }

  const len = p.body.length;
  const key = encode(head, dirIdx, foods, blocked, len, COLS, ROWS);
  const qv = table[key] || null;

  // —— 杀心：只在困难/噩梦启用 ——
  // 思路不是“撞它”（迎头相撞两条都死，不算杀），而是：
  //   1) 抢到它前方第二格，让自己身体横在它脸上
  //   2) 把它的可走方向数压到 1，逼它自己撞上来或撞墙
  let hunt = null;
  if (pf.hunt){
    let target = null, best = Infinity;
    for (const q of room.players.values()){
      if (q === p || !q.alive || !q.body || !q.body.length) continue;
      const d = Math.abs(q.body[0].x - head.x) + Math.abs(q.body[0].y - head.y);
      // 优先追真人，没有真人才追别的机器人
      const bias = q.isBot ? 2 : 0;
      if (d + bias < best){ best = d + bias; target = q; }
    }
    if (target && best <= pf.hunt.range){
      const v = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[target.dir] || { x: 1, y: 0 };
      const eHead = target.body[0];
      const next1 = { x: eHead.x + v.x, y: eHead.y + v.y };
      const next2 = { x: eHead.x + v.x * 2, y: eHead.y + v.y * 2 };
      hunt = { next1, next2, wExit: pf.hunt.wExit, wCross: pf.hunt.wCross, wChase: pf.hunt.wChase || 0 };
    }
  }

  // 数一个格子还有几个方向能走（用来评估“把人堵死”的效果）
  const exitsOf = (cell, blk) => {
    let n = 0;
    for (let i = 0; i < 4; i++){
      const nx = cell.x + VEC[i].x, ny = cell.y + VEC[i].y;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      if (blk.has(ny * COLS + nx)) continue;
      n++;
    }
    return n;
  };

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

    if (hunt){
      // 抢到它前方第二格：这步之后我的身体就横在它脸上
      if (nx === hunt.next2.x && ny === hunt.next2.y) score += hunt.wCross;
      // 正面撞它下一格 = 两条一起死，不干
      if (nx === hunt.next1.x && ny === hunt.next1.y) score -= 220;
      // 往它正前方靠：身体会一段段铺在它要走的那条线上
      score -= hunt.wChase * (Math.abs(nx - hunt.next1.x) + Math.abs(ny - hunt.next1.y));
      // 把它的出口数压下去（我的头落点、身子落点都算墙）
      const blk2 = new Set(blocked);
      blk2.delete(head.y * COLS + head.x);                       // 我这颗头要挪走
      blk2.delete(p.body[len - 1].y * COLS + p.body[len - 1].x);  // 尾巴也要挪走
      blk2.add(nk);
      const exits = exitsOf(hunt.next1, blk2);
      score += (4 - exits) * hunt.wExit;
      if (exits <= 1) score += 45;                               // 真堵死了，再奖一笔
    }
    candidates.push({ dir: NAMES[d], score, area });
  }
  if (!candidates.length) return null;

  // 慢半拍：这一拍懒得重新想，照着原方向再走一步
  if (pf.hesitate > 0 && Math.random() < pf.hesitate){
    const straight = candidates.find((c) => c.dir === p.dir);
    if (straight) return straight.dir;
  }

  // 走神：偶尔不走最优解，随便挑一个“不至于自杀”的方向。
  // 这是给人留活路的关键——没有它，AI 每一拍都是满分操作，人根本追不上。
  const slack = pf.slack;
  if (slack > 0 && candidates.length > 1 && Math.random() < slack){
    const safe = candidates.filter((c) => c.area >= len + 1);
    const pool = safe.length > 1 ? safe : candidates;
    return pool[(Math.random() * pool.length) | 0].dir;
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].dir;
}

module.exports = { train, pack, unpack, decide, encode, areaFrom, DIFFS, profileOf };
