'use strict';
/*
 * 豆包 AI —— 单人模式的电脑对手
 *
 * 故意做得比 bot/snake-bot.js 弱很多：
 *   · 只看一步的碰撞检查（不做 BFS，不会算“尾巴可达性”）
 *   · 每两拍才重新决策一次（模拟反应延迟）
 *   · 8% 概率随机乱走一步（会犯傻）
 * 所以它追食物还行，但蛇一长就会把自己绕死，适合陪玩。
 */

const DIRS = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
const OPPOSITE = { up:'down', down:'up', left:'right', right:'left' };

function decide(room, p, COLS, ROWS){
  // 反应延迟：每两拍才重新想一次
  if (room.tick < (p.botThinkAt || 0)) return null;
  p.botThinkAt = room.tick + 2;

  const head = p.body[0];
  const blocked = new Set();
  for (const q of room.players.values()){
    if (!q.alive) continue;
    // 尾巴下一步会让开，所以不算障碍
    for (let i = 0; i < q.body.length - 1; i++){
      blocked.add(q.body[i].x + ',' + q.body[i].y);
    }
  }

  const opts = [];
  for (const d of ['up','down','left','right']){
    if (d === OPPOSITE[p.dir]) continue;                 // 不能 180° 掉头
    const nx = head.x + DIRS[d].x, ny = head.y + DIRS[d].y;
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
    if (blocked.has(nx + ',' + ny)) continue;
    opts.push({ d, nx, ny });
  }
  if (!opts.length) return null;

  // 偶尔犯傻：随机挑一个能走的方向
  if (Math.random() < 0.05) return opts[(Math.random() * opts.length) | 0].d;

  // 贪心：沿最短路径追最近的食物（只算距离，不管走进去会不会把自己围死）
  const fd = foodDist(blocked, COLS, ROWS, room.foods);
  let best = null;
  for (const o of opts){
    const k = o.ny * COLS + o.nx;
    const d = fd[k] >= 0 ? fd[k] : 999;
    // 别一头钻进死胡同：落脚点至少要有 2 个空格可走
    const deadEnd = freeNeighbors(o.nx, o.ny, blocked, head, COLS, ROWS) <= 1 ? 50 : 0;
    const cost = d + deadEnd + (o.d === p.dir ? -0.5 : 0);   // 平手优先直行，避免抽风
    if (!best || cost < best.cost) best = { d:o.d, cost };
  }
  return best ? best.d : null;
}

// 某格还剩几个方向能走
function freeNeighbors(x, y, blocked, head, COLS, ROWS){
  let cnt = 0;
  for (const d of ['up','down','left','right']){
    const nx = x + DIRS[d].x, ny = y + DIRS[d].y;
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
    if (blocked.has(ny * COLS + nx)) continue;
    if (nx === head.x && ny === head.y) continue;   // 不能回头
    cnt++;
  }
  return cnt;
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
    for (const d of ['up','down','left','right']){
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
