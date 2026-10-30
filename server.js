'use strict';
/*
 * 多人联机贪吃蛇 —— 完整版：账号 + 房间 + 排行榜 + 聊天
 * 零 npm 依赖，只用 Node.js 内置模块
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 8180;
const PUBLIC_DIR = path.join(__dirname, 'dist');
const DATA_DIR = path.join(__dirname, 'data');

const COLS = 42, ROWS = 30;
const START_LEN = 3, FOOD_TARGET = 7, FOOD_MAX = 60;
const MAX_PLAYERS_PER_ROOM = 12;
const INPUT_BUFFER = 2;
const COLORS = [
  '#ef4444','#3b82f6','#22c55e','#eab308','#a855f7','#f97316',
  '#06b6d4','#ec4899','#84cc16','#6366f1','#14b8a6','#f43f5e'
];
const DIRS = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
const OPPOSITE = { up:'down', down:'up', left:'right', right:'left' };
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function randInt(n){ return (Math.random()*n)|0; }

// ============================================================
//  AUTH（账号/排行榜持久化）
// ============================================================
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// 内存缓存：Map<username, { hash, salt }>、Map<username, best>
let accounts = new Map();
let leaderboard = []; // [{u, s}]

function loadUsers(){
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_FILE,'utf8'));
    accounts = new Map(raw.map(a => [a.u, { hash:a.h, salt:a.s }]));
  } catch { accounts = new Map(); }
}
function loadScores(){
  try { leaderboard = JSON.parse(fs.readFileSync(SCORES_FILE,'utf8')); }
  catch { leaderboard = []; }
}
loadUsers(); loadScores();

// 原子写：写 .new 再 rename，防止并发写坏
function atomicWrite(file, data){
  const tmp = file + '.new';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function saveUsers(){ atomicWrite(USERS_FILE, [...accounts.entries()].map(([u,a])=>({u, h:a.hash, s:a.salt}))); }
function saveScores(){ atomicWrite(SCORES_FILE, leaderboard); }

// scrypt 密码哈希（零依赖）
function hashPass(pass){
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = crypto.scryptSync(pass, salt, 32, { cost: 16384, blockSize: 8, parallelization: 1 }).toString('base64');
  return { hash, salt };
}
function verifyPass(pass, salt, hash){
  try {
    const h = crypto.scryptSync(pass, salt, 32, { cost: 16384, blockSize: 8, parallelization: 1 }).toString('base64');
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  } catch { return false; }
}

// token 管理：Map<token, username>
const tokens = new Map();
function newToken(user){
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, user);
  return t;
}

function updateScore(user, score){
  if (!user || !score) return;
  let found = false;
  for (const entry of leaderboard){
    if (entry.u === user){ if (score > entry.s) entry.s = score; found = true; break; }
  }
  if (!found) leaderboard.push({ u: user, s: score });
  leaderboard.sort((a,b)=>b.s-a.s);
  leaderboard = leaderboard.slice(0, 50);
  saveScores();
}

// ============================================================
//  Room 类（游戏房间）
// ============================================================
class Room {
  constructor(id, name, owner, pass){
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.pass = pass || null;
    this.players = new Map(); // id -> player
    this.foods = [];
    this.tickMs = 200;
    this.tick = 0;
    this.nextPlayerId = 1;
    this.timer = setInterval(() => this.step(), this.tickMs);
    // 每 30s 心跳
    this.hbTimer = setInterval(() => {
      const now = Date.now();
      for (const p of this.players.values()){
        p.ws.ping();
        if (now - p.ws.lastSeen > 75000) p.ws.close();
      }
    }, 30000);
  }
  hasPassword(){ return !!this.pass; }
  get count(){ return this.players.size; }

  // —— 食物 / 出生点 ——
  cellOccupied(x,y){
    for (const p of this.players.values()){
      if (!p.alive) continue;
      for (const s of p.body) if (s.x===x && s.y===y) return true;
    }
    for (const f of this.foods) if (f.x===x && f.y===y) return true;
    return false;
  }
  spawnFood(){
    for (let i=0;i<200;i++){
      const x=randInt(COLS), y=randInt(ROWS);
      if (!this.cellOccupied(x,y)) { this.foods.push({x,y}); return; }
    }
  }
  // 死亡掉落：蛇尸体每隔一节变成食物（上限 FOOD_MAX）
  dropFoodFromBody(p){
    for (let i=0;i<p.body.length;i+=2){
      if (this.foods.length >= FOOD_MAX) break;
      const s = p.body[i];
      if (!this.foods.some(f=>f.x===s.x&&f.y===s.y)) this.foods.push({x:s.x,y:s.y});
    }
  }
  findSpawn(){
    for (let i=0;i<300;i++){
      const x=5+randInt(COLS-10), y=2+randInt(ROWS-4);
      let ok=true;
      for (let k=0;k<START_LEN+2;k++) if (this.cellOccupied(x-k,y)) { ok=false; break; }
      if (ok) return {x,y};
    }
    return {x:6, y:randInt(ROWS-4)+2};
  }
  resetPlayer(p){
    const c = this.findSpawn();
    p.body = [];
    for (let i=0;i<START_LEN;i++) p.body.push({x:c.x-i, y:c.y});
    p.dir='right'; p.queue=[]; p.alive=true; p.score=0; p.deathReason='';
  }

  // —— 主循环（和旧版 step 完全一致，只是移到实例方法） ——
  step(){
    this.tick++;
    for (const p of this.players.values()){
      if (!p.alive) continue;
      while (p.queue.length){
        const d = p.queue.shift();
        if (DIRS[d] && d !== OPPOSITE[p.dir]) { p.dir = d; break; }
      }
    }
    for (const p of this.players.values()){
      if (!p.alive) continue;
      const d = DIRS[p.dir];
      p.newHead = { x: p.body[0].x + d.x, y: p.body[0].y + d.y };
    }
    const dead = new Map();
    for (const p of this.players.values()){
      if (!p.alive) continue;
      const h = p.newHead;
      if (h.x<0||h.y<0||h.x>=COLS||h.y>=ROWS) dead.set(p.id,'撞墙了');
    }
    const headCells = new Map();
    for (const p of this.players.values()){
      if (!p.alive||dead.has(p.id)) continue;
      const k = p.newHead.x+','+p.newHead.y;
      if (!headCells.has(k)) headCells.set(k,[]);
      headCells.get(k).push(p);
    }
    for (const g of headCells.values()) if (g.length>1) for (const p of g) dead.set(p.id,'与对手迎头相撞');

    const eats = new Map();
    for (const p of this.players.values()){
      if (!p.alive||dead.has(p.id)) continue;
      const idx = this.foods.findIndex(f=>f.x===p.newHead.x&&f.y===p.newHead.y);
      if (idx>=0) eats.set(p.id, idx);
    }
    const bodyCells = new Map();
    for (const p of this.players.values()){
      if (!p.alive||dead.has(p.id)) continue;
      const keep = eats.has(p.id) ? p.body.length : p.body.length-1;
      for (let i=0;i<keep;i++) bodyCells.set(p.body[i].x+','+p.body[i].y, p.id);
    }
    for (const p of this.players.values()){
      if (!p.alive||dead.has(p.id)) continue;
      const owner = bodyCells.get(p.newHead.x+','+p.newHead.y);
      if (owner !== undefined) dead.set(p.id, owner===p.id ? '咬到自己了' : '撞上了对手的身体');
    }
    for (const p of this.players.values()){
      if (!p.alive) continue;
      if (dead.has(p.id)){
        p.alive = false;
        p.deathReason = dead.get(p.id);
        updateScore(p.name, p.score); // 死亡时持久化分数
        this.dropFoodFromBody(p); // 死亡掉落食物
      } else {
        p.body.unshift(p.newHead);
        if (eats.has(p.id)) p.score++;
        else p.body.pop();
      }
    }
    for (const idx of [...eats.values()].sort((a,b)=>b-a)) this.foods.splice(idx,1);
    while (this.foods.length < FOOD_TARGET) this.spawnFood();

    this.broadcastState();
  }

  setSpeed(ms){
    const v = Math.round(Number(ms));
    if (!Number.isFinite(v)) return false;
    this.tickMs = Math.min(500, Math.max(50, v));
    clearInterval(this.timer);
    this.timer = setInterval(() => this.step(), this.tickMs);
    return true;
  }

  // —— 协议 ——
  snapshot(){
    return JSON.stringify({
      t:'state',
      tick: this.tick,
      tickMs: this.tickMs,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color, score: p.score,
        alive: p.alive, dir: p.dir, seq: p.lastSeq||0,
        deathReason: p.deathReason,
        body: p.alive ? p.body.map(s=>[s.x,s.y]) : []
      })),
      foods: this.foods.map(f=>[f.x,f.y])
    });
  }
  broadcast(msg){
    for (const p of this.players.values()) p.ws.sendText(msg);
  }
  broadcastState(){ this.broadcast(this.snapshot()); }

  addPlayer(ws, username){
    if (this.players.size >= MAX_PLAYERS_PER_ROOM){
      ws.sendText(JSON.stringify({t:'sys',msg:'房间已满（最多'+MAX_PLAYERS_PER_ROOM+'人）'}));
      ws.sendText(JSON.stringify({t:'room_full'}));
      return null;
    }
    const id = this.nextPlayerId++;
    const p = {
      id, ws, name: username, color: COLORS[(id-1)%COLORS.length],
      body:[], queue:[], dir:'right', alive:false, score:0, deathReason:'', newHead:null
    };
    this.resetPlayer(p);
    this.players.set(id, p);
    ws.playerId = id; ws.room = this;
    ws.sendText(JSON.stringify({t:'joined_room', roomId:this.id, roomName:this.name, id, cols:COLS, rows:ROWS, tickMs:this.tickMs}));
    ws.sendText(this.snapshot());
    this.broadcast(JSON.stringify({t:'chat', from:'系统', text:username+' 加入了房间'}));
    return p;
  }
  removePlayer(player){
    this.players.delete(player.id);
    this.broadcast(JSON.stringify({t:'chat', from:'系统', text:player.name+' 离开了房间'}));
    this.broadcastState();
  }
  destroy(){
    clearInterval(this.timer); clearInterval(this.hbTimer);
  }
}

// —— 全局房间索引 ——
const rooms = new Map(); // id -> Room

function roomId(){
  // 6 位随机数字，冲突重试
  for (let i=0;i<20;i++){
    const id = String(randInt(900000)+100000);
    if (!rooms.has(id)) return id;
  }
  return 'r'+crypto.randomBytes(6).toString('hex');
}
function broadcastRooms(){
  const list = [...rooms.values()].map(r => ({
    id: r.id, name: r.name, owner: r.owner,
    count: r.count, max: MAX_PLAYERS_PER_ROOM, hasPwd: r.hasPassword()
  }));
  const msg = JSON.stringify({t:'rooms', items:list});
  // 发给所有已登录但未加入房间的 ws
  for (const ws of loggedInSockets){
    if (!ws.room) ws.sendText(msg);
  }
}

// —— 已登录连接索引（不区分在哪个房间） ——
const loggedInSockets = new Set(); // WSSocket

// ============================================================
//  HTTP API（注册/登录/排行榜）
// ============================================================
function sendJSON(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}
function readBody(req){
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve(null); }
    });
  });
}
function authFromReq(req){
  const h = (req.headers.authorization||'').trim();
  if (!h.startsWith('Bearer ')) return null;
  return tokens.get(h.slice(7)) || null;
}

async function handleApi(req, res, urlPath){
  if (req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }
  if (req.method === 'POST' && urlPath === '/api/register'){
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const u = String(body.u||'').trim();
    const p = String(body.p||'');
    if (!u || u.length>16 || /[^\w\u4e00-\u9fa5]/.test(u)) return sendJSON(res,400,{ok:false,msg:'用户名 1-16 字，只允许字母/数字/中文'});
    if (p.length<4 || p.length>32) return sendJSON(res,400,{ok:false,msg:'密码 4-32 位'});
    if (accounts.has(u)) return sendJSON(res,409,{ok:false,msg:'用户名已存在'});
    const { hash, salt } = hashPass(p);
    accounts.set(u, { hash, salt });
    saveUsers();
    return sendJSON(res, 200, {ok:true});
  }
  if (req.method === 'POST' && urlPath === '/api/login'){
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const u = String(body.u||'').trim();
    const p = String(body.p||'');
    const a = accounts.get(u);
    if (!a || !verifyPass(p, a.salt, a.hash)) return sendJSON(res,401,{ok:false,msg:'用户名或密码不对'});
    const token = newToken(u);
    return sendJSON(res, 200, {ok:true, token, user:u});
  }
  if (req.method === 'POST' && urlPath === '/api/logout'){
    const user = authFromReq(req);
    // 客户端自己删 token 即可；服务端不强制失效（同 token 多连接场景复杂）
    return sendJSON(res, 200, {ok:true});
  }
  // 注销账号：需 token + 密码确认，删除账号/排行榜/所有登录态
  if (req.method === 'POST' && urlPath === '/api/delete-account'){
    const u = authFromReq(req);
    if (!u) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const p = String(body.p||'');
    const a = accounts.get(u);
    if (!a || !verifyPass(p, a.salt, a.hash)) return sendJSON(res,401,{ok:false,msg:'密码不对，注销失败'});
    accounts.delete(u);
    saveUsers();
    leaderboard = leaderboard.filter(x=>x.u!==u);
    saveScores();
    for (const [t, user] of [...tokens.entries()]) if (user===u) tokens.delete(t);
    return sendJSON(res, 200, {ok:true});
  }
  if (req.method === 'GET' && urlPath === '/api/me'){
    const u = authFromReq(req);
    if (!u) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const score = leaderboard.find(x=>x.u===u);
    return sendJSON(res, 200, {ok:true, user:u, best: score ? score.s : 0});
  }
  if (req.method === 'GET' && urlPath === '/api/scores'){
    return sendJSON(res, 200, {ok:true, items: leaderboard.slice(0,20)});
  }
  sendJSON(res, 404, {ok:false,msg:'未找到'});
}

// ============================================================
//  WebSocket （RFC 6455 手写子集）
// ============================================================
function encodeFrame(str, opcode=0x1){
  const payload = Buffer.from(str,'utf8'); const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80|opcode, len]);
  else if (len < 65536){ header = Buffer.alloc(4); header[0]=0x80|opcode; header[1]=126; header.writeUInt16BE(len,2); }
  else { header = Buffer.alloc(10); header[0]=0x80|opcode; header[1]=127; header.writeBigInt64BE(BigInt(len),2); }
  return Buffer.concat([header, payload]);
}

class WSSocket {
  constructor(raw){
    this.raw = raw; this.buf = Buffer.alloc(0); this.closed = false;
    this.lastSeen = Date.now(); this.user = null; this.playerId = null; this.room = null;
    raw.on('data', d => { this.lastSeen = Date.now(); this._onData(d); });
    raw.on('error', () => this.close());
    raw.on('close', () => this.close());
  }
  sendText(str){
    if (!this.closed && this.raw.writable){
      try { this.raw.write(encodeFrame(str, 0x1)); } catch { this.close(); }
    }
  }
  ping(){ if (!this.closed && this.raw.writable){ try { this.raw.write(encodeFrame('',0x9)); } catch {} } }
  close(){
    if (this.closed) return; this.closed = true;
    try { this.raw.end(); } catch {}
    if (this.user) loggedInSockets.delete(this);
    if (this.room && this.playerId !== undefined){
      const player = this.room.players.get(this.playerId);
      if (player) this.room.removePlayer(player);
    }
    // 房间没人就销毁
    for (const [id, r] of rooms.entries()){
      if (r.count === 0){ r.destroy(); rooms.delete(id); }
    }
    broadcastRooms();
    if (this.onClose) this.onClose();
  }
  _onData(chunk){
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true){
      if (this.buf.length < 2) return;
      const b0=this.buf[0], b1=this.buf[1];
      const opcode = b0&0x0f, masked=(b1&0x80)!==0, len=b1&0x7f;
      let off=2;
      if (len===126){ if (this.buf.length<4) return; this.len=this.buf.readUInt16BE(2); off=4; }
      else if (len===127){ if (this.buf.length<10) return; this.len=Number(this.buf.readBigUInt64BE(2)); off=10; }
      let mask=null;
      if (masked){ if (this.buf.length<off+4) return; mask=this.buf.slice(off,off+4); off+=4; }
      if (this.buf.length < off+len) return;
      const payload = this.buf.slice(off, off+len);
      if (masked) for (let i=0;i<len;i++) payload[i] ^= mask[i&3];
      this.buf = this.buf.slice(off+len);

      if (opcode===0x8){ this.close(); return; }
      else if (opcode===0x9){ if (!this.closed) this.raw.write(encodeFrame(payload.toString('utf8'),0xA)); }
      else if (opcode===0x1 && this.onMessage){ this.onMessage(payload.toString('utf8')); }
    }
  }
}

// ============================================================
//  消息处理（auth → 房间 → 游戏）
// ============================================================
function handleWsMessage(ws, text){
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg.t !== 'string') return;

  // —— 未登录：只允许 auth ——
  if (!ws.user){
    if (msg.t === 'auth'){
      const user = tokens.get(msg.token);
      if (user){
        ws.user = user;
        loggedInSockets.add(ws);
        ws.sendText(JSON.stringify({t:'auth_ok', user}));
        ws.sendText(JSON.stringify({t:'rooms', items:[...rooms.values()].map(r => ({
          id:r.id, name:r.name, owner:r.owner, count:r.count, max:MAX_PLAYERS_PER_ROOM, hasPwd:r.hasPassword()
        }))}));
      } else {
        ws.sendText(JSON.stringify({t:'auth_fail', msg:'登录已过期，请重新登录'}));
      }
      return;
    }
    ws.sendText(JSON.stringify({t:'need_auth', msg:'请先登录'}));
    return;
  }

  // —— 大厅（未加入房间）：房间管理 + 聊天到全局大厅 ——
  if (!ws.room){
    if (msg.t === 'list_rooms'){
      ws.sendText(JSON.stringify({t:'rooms', items:[...rooms.values()].map(r => ({
        id:r.id, name:r.name, owner:r.owner, count:r.count, max:MAX_PLAYERS_PER_ROOM, hasPwd:r.hasPassword()
      }))}));
      return;
    }
    if (msg.t === 'create_room'){
      const name = String(msg.name||'').trim().slice(0, 20);
      if (!name) return ws.sendText(JSON.stringify({t:'sys',msg:'房间名不能为空'}));
      if (rooms.size >= 50) return ws.sendText(JSON.stringify({t:'sys',msg:'房间数已达上限'}));
      const id = roomId();
      const pass = msg.pass ? String(msg.pass).slice(0,32) : null;
      const r = new Room(id, name, ws.user, pass);
      rooms.set(id, r);
      ws.sendText(JSON.stringify({t:'room_created', id, name, owner:ws.user}));
      // 自动加入自己刚创建的房间
      r.addPlayer(ws, ws.user);
      broadcastRooms();
      return;
    }
    if (msg.t === 'join_room'){
      const id = String(msg.id||'').trim();
      const r = rooms.get(id);
      if (!r) return ws.sendText(JSON.stringify({t:'sys',msg:'房间不存在'}));
      if (r.hasPassword() && String(msg.pass||'') !== r.pass) return ws.sendText(JSON.stringify({t:'sys',msg:'密码不对'}));
      if (r.count >= MAX_PLAYERS_PER_ROOM) return ws.sendText(JSON.stringify({t:'sys',msg:'房间已满'}));
      r.addPlayer(ws, ws.user);
      broadcastRooms();
      return;
    }
    if (msg.t === 'chat'){
      const text = String(msg.text||'').trim().slice(0, 200);
      if (!text) return;
      // 大厅聊天：发给所有已登录但不在房间的用户
      const m = JSON.stringify({t:'chat', from:ws.user, text});
      for (const s of loggedInSockets) if (!s.room) s.sendText(m);
      return;
    }
    ws.sendText(JSON.stringify({t:'need_room', msg:'请先创建或加入房间'}));
    return;
  }

  // —— 已加入房间：游戏协议 ——
  const room = ws.room;
  const player = room.players.get(ws.playerId);

  if (msg.t === 'leave_room'){
    room.removePlayer(player);
    ws.room = null; ws.playerId = null;
    broadcastRooms();
    // 房间没人就销毁
    if (room.count === 0){ room.destroy(); rooms.delete(room.id); broadcastRooms(); }
    ws.sendText(JSON.stringify({t:'left_room'}));
    ws.sendText(JSON.stringify({t:'rooms', items:[...rooms.values()].map(r => ({
      id:r.id, name:r.name, owner:r.owner, count:r.count, max:MAX_PLAYERS_PER_ROOM, hasPwd:r.hasPassword()
    }))}));
    return;
  }
  if (msg.t === 'chat'){
    const text = String(msg.text||'').trim().slice(0, 200);
    if (!text) return;
    room.broadcast(JSON.stringify({t:'chat', from:ws.user, text}));
    return;
  }
  if (msg.t === 'dir'){
    if (!player || !player.alive) return;
    if (typeof msg.seq === 'number') player.lastSeq = msg.seq;
    if (DIRS[msg.dir] && player.queue.length < INPUT_BUFFER){
      const last = player.queue.length ? player.queue[player.queue.length-1] : player.dir;
      if (msg.dir !== last && msg.dir !== OPPOSITE[last]) player.queue.push(msg.dir);
    }
    return;
  }
  if (msg.t === 'respawn'){
    if (player && !player.alive) room.resetPlayer(player);
    return;
  }
  if (msg.t === 'ping'){
    ws.sendText(JSON.stringify({t:'pong', ts:msg.ts}));
    return;
  }
  if (msg.t === 'speed'){
    if (room.setSpeed(msg.ms)){
      room.broadcast(JSON.stringify({t:'sys', msg: ws.user+' 把速度调成了 '+room.tickMs+'ms/步'}));
    }
    return;
  }
}

function onConnection(ws){
  ws.onMessage = text => handleWsMessage(ws, text);
  ws.onClose = () => {}; // close() 里已经做了全部清理
}

// ============================================================
//  HTTP server（静态 + API）
// ============================================================
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png',
  '.ico':'image/x-icon', '.sb3':'application/octet-stream',
  '.apk':'application/vnd.android.package-archive', '.ipa':'application/octet-stream',
  '.dmg':'application/x-apple-diskimage', '.zip':'application/zip',
  '.map':'application/json'
};

const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end('Bad Request'); }

  // API 走异步处理器
  if (urlPath.startsWith('/api/')) return handleApi(req, res, urlPath);

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)){ res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err){ res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); return res.end('404'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream'});
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const headers = req.headers;
  if ((headers.upgrade||'').toLowerCase() !== 'websocket' || !headers['sec-websocket-key']){ socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(headers['sec-websocket-key'] + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  onConnection(new WSSocket(socket));
});

// ============================================================
//  启动
// ============================================================
function lanIPs(){
  const result = [];
  for (const name of Object.keys(os.networkInterfaces())){
    for (const net of os.networkInterfaces()[name]) if (net.family==='IPv4' && !net.internal) result.push(net.address);
  }
  return result;
}

server.listen(PORT, () => {
  console.log('');
  console.log('  🐍 多人联机贪吃蛇（完整版：账号+房间+排行榜+聊天）');
  console.log('  本机：  http://localhost:'+PORT);
  for (const ip of lanIPs()) console.log('  同 Wi-Fi：http://'+ip+':'+PORT);
  console.log('  Ctrl+C 停止');
  console.log('');
});
