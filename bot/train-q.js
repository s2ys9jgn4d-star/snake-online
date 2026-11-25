'use strict';
/*
 * 训练派派 AI，并把账本存成 bot/qtable.json
 * 用法：
 *   node bot/train-q.js               默认 1200 局
 *   node bot/train-q.js 3000          训 3000 局
 *   node bot/train-q.js 1200 eval     训完顺手考 30 局
 */
const fs = require('fs');
const path = require('path');
const q = require('./qagent');

const COLS = 42, ROWS = 30;
const episodes = Math.max(200, parseInt(process.argv[2], 10) || 1200);
const wantEval = process.argv.includes('eval');

const t0 = Date.now();
const { table, stats } = q.train({ episodes, COLS, ROWS, maxSteps: 400 });
const spent = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`训练 ${stats.episodes} 局，用时 ${spent}s`);
console.log(`账本里记了 ${stats.states} 种情况`);
console.log(`训练中撞死 ${stats.deaths} 次，吃到 ${stats.apples} 个苹果`);
console.log(`平均每局 ${stats.avgSteps} 步 / ${stats.avgApples} 个苹果`);

const pack = q.pack(table);
const out = path.join(__dirname, 'qtable.json');
fs.writeFileSync(out, JSON.stringify(pack));
console.log(`已写入 ${out}（${(fs.statSync(out).size / 1024).toFixed(1)} KB）`);

// —— 考一考：照账本走，看它到底会不会吃苹果 ——
function evalOne(seed){
  const id = 1;
  const p = {
    id, name: '派派', body: [], dir: 'right', alive: true, queue: [], isBot: true
  };
  const cy = 6 + (seed % (ROWS - 12));
  for (let i = 0; i < 3; i++) p.body.push({ x: 10 - i, y: cy });

  const room = { players: new Map([[id, p]]), foods: [{ x: 20 + (seed % 15), y: cy }] };
  let steps = 0, apples = 0;
  const startLen = p.body.length;

  while (steps < 500){
    const d = q.decide(room, p, COLS, ROWS, table);
    if (!d) break;
    p.dir = d;
    const vec = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[d];
    const nh = { x: p.body[0].x + vec.x, y: p.body[0].y + vec.y };
    steps++;

    const wall = nh.x < 0 || nh.y < 0 || nh.x >= COLS || nh.y >= ROWS;
    const bite = !wall && p.body.some((s, i) => i < p.body.length - 1 && s.x === nh.x && s.y === nh.y);
    if (wall || bite) return { steps, apples, dead: true };

    p.body.unshift(nh);
    const fi = room.foods.findIndex((f) => f.x === nh.x && f.y === nh.y);
    if (fi >= 0){
      apples++;
      room.foods.splice(fi, 1);
      // 换新苹果，避开身体
      for (let t = 0; t < 200; t++){
        const nx = (nxRnd++) % COLS, ny = (nyRnd += 7) % ROWS;
        if (!p.body.some((s) => s.x === nx && s.y === ny) && !room.foods.some((f) => f.x === nx && f.y === ny)){
          room.foods.push({ x: nx, y: ny });
          break;
        }
      }
    } else {
      p.body.pop();
    }
  }
  return { steps, apples, dead: false, len: p.body.length - startLen };
}

let nxRnd = 7, nyRnd = 11;
if (wantEval){
  const res = [];
  for (let i = 0; i < 30; i++){
    nxRnd = 3 + i * 5; nyRnd = 9 + i;
    res.push(evalOne(i * 37 + 11));
  }
  const avgApple = res.reduce((s, r) => s + r.apples, 0) / res.length;
  const deadRate = res.filter((r) => r.dead).length / res.length;
  console.log(`\n考场 30 局：平均吃 ${avgApple.toFixed(2)} 个，撞死率 ${(deadRate * 100).toFixed(0)}%`);
  console.log(`最多 ${Math.max(...res.map((r) => r.apples))} 个 / 最长活 ${Math.max(...res.map((r) => r.steps))} 步`);
}
