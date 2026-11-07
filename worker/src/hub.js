'use strict';
/*
 * 多人联机贪吃蛇 —— Durable Object（整个游戏世界）
 * 逐条移植自 /Users/niemac13/snake-online/server.js，协议字段与玩法保持一致。
 */
import scryptLib from 'scrypt-js';
import seed from '../seed.json';

const scrypt = scryptLib.scrypt;

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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const encoder = new TextEncoder();

function randInt(n){ return (Math.random()*n)|0; }
function randomBytes(n){
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function bytesToBase64(bytes){
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function timingSafeEqual(a, b){
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============================================================
//  密码：与 Node 版 crypto.scryptSync(pass, salt, 32, {cost:16384, blockSize:8, parallelization:1}) 完全一致
//  salt 按字符串的 UTF-8 字节传入（不是 base64 解码），结果存 base64
// ============================================================
async function scryptB64(pass, salt){
  const out = await scrypt(
    encoder.encode(String(pass)),
    encoder.encode(String(salt)),
    16384, 8, 1, 32
  );
  return bytesToBase64(out);
}
async function hashPass(pass){
  const salt = bytesToBase64(randomBytes(16));
  const hash = await scryptB64(pass, salt);
  return { hash, salt };
}
async function verifyPass(pass, salt, hash){
  try {
    const h = await scryptB64(pass, salt);
    return timingSafeEqual(h, hash);
  } catch { return false; }
}

function sendJSON(code, obj){
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}
async function readBody(request){
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch { return null; }
}
function authFromReq(hub, request){
  const h = (request.headers.get('Authorization') || '').trim();
  if (!h.startsWith('Bearer ')) return null;
  return hub.tokens.get(h.slice(7)) || null;
}

// ============================================================
//  WebSocket 连接包装（对应 Node 版 WSSocket）
// ============================================================
class Sock {
  constructor(raw, hub){
    this.raw = raw;
    this.hub = hub;
    this.closed = false;
    this.lastSeen = Date.now();
    this.user = null;
    this.playerId = null;
    this.room = null;
  }
  sendText(str){
    if (this.closed) return;
    try { this.raw.send(str); } catch { this.close(); }
  }
  close(){
    if (this.closed) return;
    this.closed = true;
    try { this.raw.close(); } catch {}
    if (this.user) this.hub.loggedInSockets.delete(this);
    if (this.room && this.playerId !== null && this.playerId !== undefined){
      const player = this.room.players.get(this.playerId);
      if (player) this.room.removePlayer(player);
    }
    // 房间没人就销毁
    for (const [id, r] of this.hub.rooms.entries()){
      if (r.count === 0){ r.destroy(); this.hub.rooms.delete(id); }
    }
    this.hub.broadcastRooms();
  }
}

// ============================================================
//  Room 类（游戏房间）
// ============================================================
class Room {
  constructor(hub, id, name, owner, pass){
    this.hub = hub;
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
    // 每 30s 心跳（Workers 无法发送 ping 帧，客户端每 2s 发 {t:'ping'}，这里只做超时清理）
    this.hbTimer = setInterval(() => {
      const now = Date.now();
      for (const p of this.players.values()){
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

  // —— 主循环（和 Node 版 step 完全一致）——
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
        this.hub.updateScore(p.name, p.score); // 死亡时持久化分数
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

function handleWsMessage(hub, ws, text){
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg.t !== 'string') return;

  // —— 未登录：只允许 auth ——
  if (!ws.user){
    if (msg.t === 'auth'){
      const user = hub.tokens.get(msg.token);
      if (user){
        ws.user = user;
        hub.loggedInSockets.add(ws);
        ws.sendText(JSON.stringify({t:'auth_ok', user}));
        ws.sendText(JSON.stringify({t:'rooms', items:hub.roomList()}));
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
      ws.sendText(JSON.stringify({t:'rooms', items:hub.roomList()}));
      return;
    }
    if (msg.t === 'create_room'){
      const name = String(msg.name||'').trim().slice(0, 20);
      if (!name) return ws.sendText(JSON.stringify({t:'sys',msg:'房间名不能为空'}));
      if (hub.rooms.size >= 50) return ws.sendText(JSON.stringify({t:'sys',msg:'房间数已达上限'}));
      const id = hub.roomId();
      const pass = msg.pass ? String(msg.pass).slice(0,32) : null;
      const r = new Room(hub, id, name, ws.user, pass);
      hub.rooms.set(id, r);
      ws.sendText(JSON.stringify({t:'room_created', id, name, owner:ws.user}));
      // 自动加入自己刚创建的房间
      r.addPlayer(ws, ws.user);
      hub.broadcastRooms();
      return;
    }
    if (msg.t === 'join_room'){
      const id = String(msg.id||'').trim();
      const r = hub.rooms.get(id);
      if (!r) return ws.sendText(JSON.stringify({t:'sys',msg:'房间不存在'}));
      if (r.hasPassword() && String(msg.pass||'') !== r.pass) return ws.sendText(JSON.stringify({t:'sys',msg:'密码不对'}));
      if (r.count >= MAX_PLAYERS_PER_ROOM) return ws.sendText(JSON.stringify({t:'sys',msg:'房间已满'}));
      r.addPlayer(ws, ws.user);
      hub.broadcastRooms();
      return;
    }
    if (msg.t === 'chat'){
      const text = String(msg.text||'').trim().slice(0, 200);
      if (!text) return;
      // 大厅聊天：发给所有已登录但不在房间的用户
      const m = JSON.stringify({t:'chat', from:ws.user, text});
      for (const s of hub.loggedInSockets) if (!s.room) s.sendText(m);
      return;
    }
    ws.sendText(JSON.stringify({t:'need_room', msg:'请先创建或加入房间'}));
    return;
  }

  // —— 已加入房间：游戏协议 ——
  const room = ws.room;
  const player = room.players.get(ws.playerId);

  if (msg.t === 'leave_room'){
    if (player) room.removePlayer(player);
    ws.room = null; ws.playerId = null;
    hub.broadcastRooms();
    // 房间没人就销毁
    if (room.count === 0){ room.destroy(); hub.rooms.delete(room.id); hub.broadcastRooms(); }
    ws.sendText(JSON.stringify({t:'left_room'}));
    ws.sendText(JSON.stringify({t:'rooms', items:hub.roomList()}));
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

// ============================================================
//  Hub：单实例承载全部房间 / 账号 / 排行榜 / token
// ============================================================
export class Hub {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.rooms = new Map();            // id -> Room
    this.loggedInSockets = new Set();  // Sock
    this.accounts = new Map();         // username -> { hash, salt }
    this.leaderboard = [];             // [{u, s}]
    this.tokens = new Map();           // token -> username
    this.saveTimer = null;

    state.blockConcurrencyWhile(async () => {
      let users = await state.storage.get('users');
      let scores = await state.storage.get('scores');
      const tokens = await state.storage.get('tokens');

      if (!users){
        users = seed.users;
        if (!scores) scores = seed.scores;
        await state.storage.put({ users, scores });
      }
      this.accounts = new Map((users || []).map(a => [a.u, { hash: a.h, salt: a.s }]));
      this.leaderboard = scores || [];
      this.tokens = new Map(tokens || []);
    });
  }

  // —— 持久化（合并成一次 put）——
  persist(){
    return this.state.storage.put({
      users: [...this.accounts.entries()].map(([u,a]) => ({ u, h: a.hash, s: a.salt })),
      scores: this.leaderboard,
      tokens: [...this.tokens.entries()]
    });
  }
  scheduleSave(){
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist().catch(() => {});
    }, 300);
  }

  newToken(user){
    const t = [...randomBytes(24)].map(b => b.toString(16).padStart(2,'0')).join('');
    this.tokens.set(t, user);
    return t;
  }
  updateScore(user, score){
    if (!user || !score) return;
    let found = false;
    for (const entry of this.leaderboard){
      if (entry.u === user){ if (score > entry.s) entry.s = score; found = true; break; }
    }
    if (!found) this.leaderboard.push({ u: user, s: score });
    this.leaderboard.sort((a,b)=>b.s-a.s);
    this.leaderboard = this.leaderboard.slice(0, 50);
    this.scheduleSave();
  }

  roomId(){
    // 6 位随机数字，冲突重试
    for (let i=0;i<20;i++){
      const id = String(randInt(900000)+100000);
      if (!this.rooms.has(id)) return id;
    }
    return 'r'+[...randomBytes(6)].map(b => b.toString(16).padStart(2,'0')).join('');
  }
  roomList(){
    return [...this.rooms.values()].map(r => ({
      id: r.id, name: r.name, owner: r.owner,
      count: r.count, max: MAX_PLAYERS_PER_ROOM, hasPwd: r.hasPassword()
    }));
  }
  broadcastRooms(){
    const msg = JSON.stringify({ t:'rooms', items:this.roomList() });
    // 发给所有已登录但未加入房间的 ws
    for (const ws of this.loggedInSockets){
      if (!ws.room) ws.sendText(msg);
    }
  }

  // —— HTTP / WebSocket 入口 ——
  async fetch(request){
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    if (upgrade === 'websocket') return this.acceptWebSocket();

    const url = new URL(request.url);
    return this.handleApi(request, url);
  }

  acceptWebSocket(){
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const sock = new Sock(server, this);
    server.addEventListener('message', ev => {
      sock.lastSeen = Date.now();
      if (typeof ev.data === 'string') handleWsMessage(this, sock, ev.data);
    });
    server.addEventListener('close', () => sock.close());
    server.addEventListener('error', () => sock.close());
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleApi(request, url){
    const urlPath = url.pathname;

    if (request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === 'POST' && urlPath === '/api/register'){
      const body = await readBody(request);
      if (!body) return sendJSON(400, {ok:false,msg:'请求格式错误'});
      const u = String(body.u||'').trim();
      const p = String(body.p||'');
      if (!u || u.length>16 || /[^\w\u4e00-\u9fa5]/.test(u)) return sendJSON(400,{ok:false,msg:'用户名 1-16 字，只允许字母/数字/中文'});
      if (p.length<4 || p.length>32) return sendJSON(400,{ok:false,msg:'密码 4-32 位'});
      if (this.accounts.has(u)) return sendJSON(409,{ok:false,msg:'用户名已存在'});
      const { hash, salt } = await hashPass(p);
      this.accounts.set(u, { hash, salt });
      await this.persist();
      return sendJSON(200, {ok:true});
    }

    if (request.method === 'POST' && urlPath === '/api/login'){
      const body = await readBody(request);
      if (!body) return sendJSON(400, {ok:false,msg:'请求格式错误'});
      const u = String(body.u||'').trim();
      const p = String(body.p||'');
      const a = this.accounts.get(u);
      if (!a || !(await verifyPass(p, a.salt, a.hash))) return sendJSON(401,{ok:false,msg:'用户名或密码不对'});
      const token = this.newToken(u);
      await this.persist();
      return sendJSON(200, {ok:true, token, user:u});
    }

    if (request.method === 'POST' && urlPath === '/api/logout'){
      // 客户端自己删 token 即可；服务端不强制失效（同 token 多连接场景复杂）
      return sendJSON(200, {ok:true});
    }

    // 注销账号：需 token + 密码确认，删除账号/排行榜/所有登录态
    if (request.method === 'POST' && urlPath === '/api/delete-account'){
      const u = authFromReq(this, request);
      if (!u) return sendJSON(401, {ok:false,msg:'未登录'});
      const body = await readBody(request);
      if (!body) return sendJSON(400, {ok:false,msg:'请求格式错误'});
      const p = String(body.p||'');
      const a = this.accounts.get(u);
      if (!a || !(await verifyPass(p, a.salt, a.hash))) return sendJSON(401,{ok:false,msg:'密码不对，注销失败'});
      this.accounts.delete(u);
      this.leaderboard = this.leaderboard.filter(x=>x.u!==u);
      for (const [t, user] of [...this.tokens.entries()]) if (user===u) this.tokens.delete(t);
      await this.persist();
      return sendJSON(200, {ok:true});
    }

    if (request.method === 'GET' && urlPath === '/api/me'){
      const u = authFromReq(this, request);
      if (!u) return sendJSON(401, {ok:false,msg:'未登录'});
      const score = this.leaderboard.find(x=>x.u===u);
      return sendJSON(200, {ok:true, user:u, best: score ? score.s : 0});
    }

    if (request.method === 'GET' && urlPath === '/api/scores'){
      return sendJSON(200, {ok:true, items: this.leaderboard.slice(0,20)});
    }

    return sendJSON(404, {ok:false,msg:'未找到'});
  }
}
