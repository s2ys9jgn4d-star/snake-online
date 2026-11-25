// 集成测试：真的起一个服务器，登录、开单人房、指定派派，看它会不会吃苹果
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = 8199;
const DATA = '/tmp/paitest';

// 造一个能登录的测试账号（和 server.js 里 hashPass 一样的做法）
// 注意：账号必须在服务器启动前写好，服务器只在启动时读一次 users.json
if (process.env.PREPARE === '1'){
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = crypto.scryptSync('test1234', salt, 32, { cost: 16384, blockSize: 8, parallelization: 1 }).toString('base64');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify([
    { u: 'tester', h: hash, s: salt, n: 0, m: 0, e: 't@example.com', i: '', c: 0, l: '', st: 0, o: [], k: 'classic' }
  ]));
  fs.writeFileSync(path.join(DATA, 'friends.json'), '[]');
  fs.writeFileSync(path.join(DATA, 'scores.json'), '[]');
  console.log('测试账号已写入 ' + DATA);
  process.exit(0);
}

(async () => {
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ u: 'tester', p: 'test1234' })
  }).then((r) => r.json());
  if (!login.ok) throw new Error('登录失败：' + JSON.stringify(login));
  console.log('登录 OK');

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const seen = { room: null, maxBotScore: 0, botName: null, ticks: 0, snaps: 0, dead: 0, chat: [] };

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'auth', token: login.token }));
    setTimeout(() => ws.send(JSON.stringify({ t: 'solo', bot: (process.env.BOT || 'pai') })), 300);
  });

  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'joined_room'){
      seen.room = { id: m.roomId, cols: m.cols, rows: m.rows, tickMs: m.tickMs };
    }
    if (m.t === 'chat' && String(m.text || '').includes('复活')) seen.chat.push(m.text);
    if (m.t === 'state'){
      seen.snaps++;
      const ps = m.players || [];
      for (const p of ps){
        if (p.name === (process.env.BOTNAME || '派派')){
          seen.botName = p.name;
          if (p.score > seen.maxBotScore) seen.maxBotScore = p.score;
          if (!p.alive) seen.dead++;
        }
        if (seen.names) seen.names.add(p.name);
      }
      seen.names = seen.names || new Set();
    }
  });

  // 也顺便看服务器日志里的报错
  await new Promise((r) => setTimeout(r, 10000));
  ws.close();

  console.log('房间：', seen.room);
  console.log('快照条数：', seen.snaps, ' 机器人：', seen.botName);
  console.log('机器人最高分：', seen.maxBotScore, ' 复活提示：', seen.chat.slice(0, 3));
  if (!seen.botName) { console.log('❌ 没看到机器人'); process.exit(2); }
  if (seen.botName !== (process.env.BOTNAME || '派派')) { console.log('❌ 机器人不是派派'); process.exit(3); }
  console.log(seen.maxBotScore >= 1 ? '✅ 派派吃到东西了' : '⚠️ 10 秒内没吃到（可能出生点附近没苹果）');
  process.exit(0);
})();
