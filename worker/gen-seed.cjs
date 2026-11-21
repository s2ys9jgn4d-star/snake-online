// 把 Node 版 data/*.json 压成 Worker 首启用的 seed.json
const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname, '..', 'data');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch { return d; } };
const users = read('users.json', []).map(u => ({
  u: u.u, h: u.h, s: u.s, n: u.n || 0, m: u.m || 0, e: u.e || '',
  c: u.c || 0, l: u.l || '', st: u.st || 0,
  o: Array.isArray(u.o) ? u.o : [], k: u.k || 'classic'
}));
const scores = (read('scores.json', []) || []).slice(0, 50).map(x => ({ u: x.u, s: x.s }));
fs.writeFileSync(path.join(__dirname, 'seed.json'), JSON.stringify({ users, scores }, null, 1), 'utf8');
console.log('seed:', users.length, '用户 /', scores.length, '条成绩');
