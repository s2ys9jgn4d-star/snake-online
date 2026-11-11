'use strict';
/*
 * 豆包 AI —— 单人模式的电脑对手
 *
 * 故意做得比 bot/snake-bot.js 弱很多（那个是“代打”，几乎不会死）：
 *   · 只看一步的碰撞，不做“尾巴可达性”这种高级安全检查
 *   · 15% 概率慢半拍（照着原方向再走一步）
 *   · 8% 概率随机乱走一步（会犯傻）
 *   · 12 格以外的食物懒得追
 * 所以它抢食物还行，能一直陪玩，但不会强到让小朋友没得玩。
 *
 * 所有格子都用数字编号 k = y * COLS + x（比字符串键快，也不容易写错）
 */

const DIRS = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
const OPPOSITE = { up:'down', down:'up', left:'right', right:'left' };
const ORDER = ['up','down','left','right'];

function decide(room, p, COLS, ROWS){
  const head = p.body[0];
  const blocked = occupancy(room, COLS, ROWS);

  // 一步之内能走的方向
  const opts = [];
  for (const d of ORDER){
    if (d === OPPOSITE[p.dir]) continue;                 // 不能 180° 掉头
    const nx = head.x + DIRS[d].x, ny = head.y + DIRS[d].y;
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
    const k = ny * COLS + nx;
    if (blocked.has(k)) continue;
    opts.push({ d, x:nx, y:ny, k });
  }
  if (!opts.length) return null;

  // 偶尔犯傻：随机挑一个能走的方向
  if (Math.random() < 0.08) return opts[(Math.random() * opts.length) | 0].d;

  // 慢半拍：这一拍先不动脑子，照着原方向再走一步（前面走不通时才正常决策）
  if (Math.random() < 0.15){
    const straight = opts.find(o => o.d === p.dir);
    if (straight) return p.dir;
  }

  // 每格到最近食物要走几步（-1 = 走不到）
  const fd = foodDist(blocked, COLS, ROWS, room.foods);
  // 太远的食物懒得追（真人也常常就近吃），顺便降低它的成长速度
  const CHASE = 12;
  const reachable = opts.filter(o => fd[o.k] >= 0 && fd[o.k] <= CHASE);

  // 附近没有食物（或被蛇身围住）：往空间最大的方向走，别原地转圈
  if (!reachable.length){
    let best = null;
    for (const o of opts){
      let area = reachArea(o.k, blocked, 120, COLS, ROWS);
      if (o.d === p.dir) area += 3;                      // 稍微偏向直行
      if (!best || area > best.area) best = { d:o.d, area };
    }
    return best.d;
  }

  const len = p.body.length;
  let best = null;
  for (const o of reachable){
    let cost = fd[o.k];
    // 落脚之后剩下的空间太小，说明会把自己关进口袋里
    const area = reachArea(o.k, blocked, len + 40, COLS, ROWS);
    if (area < len + 2) cost += 200;
    if (o.d === p.dir) cost -= 0.5;                      // 平手优先直行，避免抽风
    if (!best || cost < best.cost) best = { d:o.d, cost };
  }
  return best ? best.d : null;
}

// 障碍格：所有活蛇的身体（尾巴不算，因为它每步都会让开）
function occupancy(room, COLS, ROWS){
  const blocked = new Set();
  for (const q of room.players.values()){
    if (!q.alive || !q.body.length) continue;
    for (let i = 0; i < q.body.length - 1; i++){
      blocked.add(q.body[i].y * COLS + q.body[i].x);
    }
  }
  return blocked;
}

// 从某格出发最多能走到多少个空格（数到 cap 就提前返回，避免全盘扫描）
function reachArea(start, blocked, cap, COLS, ROWS){
  const seen = new Set([start]);
  const q = [start];
  for (let qi = 0; qi < q.length; qi++){
    const k = q[qi], x = k % COLS, y = (k / COLS) | 0;
    for (const d of ORDER){
      const nx = x + DIRS[d].x, ny = y + DIRS[d].y;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const nk = ny * COLS + nx;
      if (seen.has(nk) || blocked.has(nk)) continue;
      seen.add(nk); q.push(nk);
      if (q.length >= cap) return q.length;
    }
  }
  return q.length;
}

// 多源 BFS：每格到最近食物要走几步（-1 = 走不到）
function foodDist(blocked, COLS, ROWS, foods){
  const dist = new Int16Array(COLS * ROWS).fill(-1);
  const q = [];
  for (const f of foods){
    const k = f.y * COLS + f.x;
    if (blocked.has(k)) continue;
    if (dist[k] === 0) continue;
    dist[k] = 0; q.push(k);
  }
  for (let qi = 0; qi < q.length; qi++){
    const k = q[qi], x = k % COLS, y = (k / COLS) | 0;
    for (const d of ORDER){
      const nx = x + DIRS[d].x, ny = y + DIRS[d].y;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const nk = ny * COLS + nx;
      if (dist[nk] !== -1 || blocked.has(nk)) continue;
      dist[nk] = dist[k] + 1; q.push(nk);
    }
  }
  return dist;
}

module.exports = { decide };
