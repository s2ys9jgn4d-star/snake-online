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
const SKINS = [
  { id:'classic', name:'经典原色', price:0,   color:null,      desc:'系统分配的颜色，免费' },
  { id:'neon',    name:'霓虹紫',   price:25,  color:'#a855f7', desc:'紫得发光' },
  { id:'ice',     name:'冰蓝',     price:25,  color:'#38bdf8', desc:'冷静的水蓝' },
  { id:'lime',    name:'柠檬绿',   price:40,  color:'#a3e635', desc:'比草地更亮一等' },
  { id:'gold',    name:'黄金',     price:80,  color:'#facc15', glow:1, desc:'自带金边光晕' },
  { id:'rose',    name:'玫瑰',     price:80,  color:'#fb7185', glow:1, desc:'带光晕的粉' },
  { id:'rainbow', name:'彩虹',     price:150, color:'#f472b6', rainbow:1, desc:'每一节换一个颜色' },
  { id:'shadow',  name:'墨影',     price:200, color:'#f8fafc', glow:1, desc:'黑底上的白色残影' }
];
const SKIN_MAP = new Map(SKINS.map(s => [s.id, s]));
const OFFICIAL_NAME = 'SnakeOnline官方';
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const normalizeEmail = e => String(e || '').trim().toLowerCase();
function randHex(n){
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2,'0')).join('');
}
// 官方账号自动拥有全部皮肤
function ownedSkinsOf(u, a){
  const base = new Set((a && Array.isArray(a.owned)) ? a.owned.slice() : []);
  base.add('classic');
  if (u === OFFICIAL_NAME) SKINS.forEach(s => base.add(s.id));
  return [...base];
}
// 签到按北京时间算天
function dayKey(d){
  const t = d || new Date();
  return new Date(t.getTime() + 8*3600*1000).toISOString().slice(0, 10);
}
function prevDayKey(key){
  const t = new Date(key + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
function checkinReward(streak){
  if (streak >= 7) return 20;
  if (streak >= 3) return 15;
  return 10;
}
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
        id: p.id, name: p.name, color: p.color, skin: p.skin, score: p.score,
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
      id, ws, name: username,
      color: this.hub.colorOf(username) || COLORS[(id-1)%COLORS.length],
      skin: this.hub.skinOf(username).id,
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
      if (hub.isGuest(ws.user)) return ws.sendText(JSON.stringify({t:'sys',msg:'游客不能开房间，挑一个房间加入吧', key:'guestNoCreate'}));
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
      if (hub.isGuest(ws.user)) return ws.sendText(JSON.stringify({t:'sys',msg:'游客不能在大厅发言，进房间后就能聊', key:'guestNoLobbyChat'}));
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
    this.guests = new Set();
    this.mailCodes = new Map();      // email -> {code, u, exp, kind}
    this.mailCooldowns = new Map();  // key -> 上次发送时间
    this.oauthStates = new Map();    // state -> {p, ret, exp}
    this.oauthTickets = new Map();   // 一次性票据 -> {user, exp}

    state.blockConcurrencyWhile(async () => {
      let users = await state.storage.get('users');
      let scores = await state.storage.get('scores');
      const tokens = await state.storage.get('tokens');

      if (!users){
        users = seed.users;
        if (!scores) scores = seed.scores;
        await state.storage.put({ users, scores });
      }
      this.accounts = new Map((users || []).map(a => [a.u, {
        hash: a.h, salt: a.s, email: a.e || '',
        coins: a.c || 0, lastCheckin: a.l || '', streak: a.st || 0,
        owned: Array.isArray(a.o) ? a.o.slice() : [], skin: a.k || 'classic',
        strikes: a.n || 0, muteUntil: a.m || 0
      }]));
      this.leaderboard = scores || [];
      this.tokens = new Map(tokens || []);
      this.guests = new Set(await state.storage.get('guests') || []);
    });
  }

  // —— 持久化（合并成一次 put）——
  persist(){
    return this.state.storage.put({
      users: [...this.accounts.entries()].map(([u,a]) => ({ u, h: a.hash, s: a.salt, n: a.strikes||0, m: a.muteUntil||0, e: a.email||'', c: a.coins||0, l: a.lastCheckin||'', st: a.streak||0, o: a.owned||[], k: a.skin||'classic' })),
      scores: this.leaderboard,
      tokens: [...this.tokens.entries()],
      guests: [...this.guests]
    });
  }
  scheduleSave(){
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist().catch(() => {});
    }, 300);
  }

  // ——— 发信（Brevo HTTP API；Workers 不能连 SMTP） ———
  mailReady(){
    return !!(this.env && this.env.BREVO_API_KEY);
  }
  async sendMail(to, subject, html){
    const env = this.env || {};
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: env.MAIL_FROM_NAME || '联机贪吃蛇', email: env.MAIL_FROM || '' },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    }).catch(() => null);
    return !!(resp && resp.ok);
  }
  async issueCode(email, kind, username){
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const existed = this.mailCodes.get(email);
    if (existed && existed.exp > Date.now() && existed.code) { /* 覆盖即可 */ }
    this.mailCodes.set(email, { code, kind, u: username || '', exp: Date.now() + 10 * 60 * 1000 });
    return code;
  }

  // ——— 第三方登录（目前只接 Google） ———
  siteOrigin(){
    return (this.env && this.env.SITE_ORIGIN) || 'https://snakes-online.pages.dev';
  }
  oauthConf(p){
    const env = this.env || {};
    if (p === 'google'){
      return {
        id: env.GOOGLE_CLIENT_ID || '',
        secret: env.GOOGLE_CLIENT_SECRET || '',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scope: 'openid email profile'
      };
    }
    return null;
  }
  oauthReady(p){ const c = this.oauthConf(p); return !!(c && c.id && c.secret); }
  accountByEmail(email){
    if (!email) return '';
    for (const [u, a] of this.accounts) if (a.email === email) return u;
    return '';
  }
  usernameFromEmail(email, name){
    let base = String(name || email.split('@')[0] || '').replace(/[^0-9A-Za-z_\u4e00-\u9fa5]/g, '');
    if (base.length < 2) base = email.split('@')[0].replace(/[^0-9A-Za-z_]/g, '');
    if (base.length < 2) base = 'player';
    base = base.slice(0, 14);
    for (let i = 1; i <= 999; i++){
      const cand = i === 1 ? base : base + i;
      if (!this.accounts.has(cand) && !this.guests.has(cand) && cand !== OFFICIAL_NAME) return cand;
    }
    return 'player' + randHex(3);
  }

  // Google 登录：start 跳转、callback 换 token 拿邮箱、exchange 换站内 token
  async handleOauth(request, url){
    const path = url.pathname;
    if (!path.startsWith('/api/oauth')) return null;
    const origin = this.siteOrigin();

    if (path === '/api/oauth/exchange' && request.method === 'POST'){
      const body = await request.json().catch(() => null);
      const code = String((body && body.code) || '');
      const t = this.oauthTickets.get(code);
      if (!t || t.exp < Date.now()) return sendJSON(400, { ok:false, msg:'登录已过期，请重试', key:'oauthFail' });
      this.oauthTickets.delete(code);
      const token = this.newToken(t.user);
      this.scheduleSave();
      return sendJSON(200, { ok:true, token, user:t.user, muteLeft:0, guest:false });
    }

    const m = path.match(/^\/api\/oauth\/([a-z]+)\/(start|callback)$/);
    if (!m || request.method !== 'GET') return null;
    const p = m[1], kind = m[2];
    const conf = this.oauthConf(p);
    if (!this.oauthReady(p)){
      return new Response('<meta charset="utf-8"><p style="font:16px sans-serif;padding:24px">这个登录方式还没配置，先去 Cloudflare 里加 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET。</p>',
        { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const redirectUri = origin + '/api/oauth/' + p + '/callback';

    if (kind === 'start'){
      let ret = String(url.searchParams.get('return') || '');
      try {
        const ru = new URL(ret);
        if (!/^https?:$/.test(ru.protocol) || ru.hostname !== new URL(origin).hostname) ret = '';
      } catch { ret = ''; }
      if (!ret) ret = origin + '/mobile.html';
      const state = randHex(16);
      this.oauthStates.set(state, { p, ret, exp: Date.now() + 5 * 60 * 1000 });
      const params = new URLSearchParams({
        client_id: conf.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: conf.scope,
        state,
        prompt: 'select_account'
      });
      return Response.redirect(conf.authUrl + '?' + params.toString(), 302);
    }

    // 回调：验 state → 换 access_token → 拿已验证邮箱 → 发一次性票据
    const state = String(url.searchParams.get('state') || '');
    const ent = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    if (!ent || ent.exp < Date.now() || ent.p !== p) return Response.redirect(origin + '/mobile.html?oauth=state', 302);
    const ret = ent.ret;
    const back = reason => Response.redirect(ret + (ret.includes('?') ? '&' : '?') + 'oauth=' + reason, 302);
    if (url.searchParams.get('error')) return back('denied');
    const code = String(url.searchParams.get('code') || '');
    if (!code) return back('nocode');

    const form = new URLSearchParams({
      client_id: conf.id, client_secret: conf.secret,
      code, grant_type: 'authorization_code', redirect_uri: redirectUri
    });
    const tr = await fetch(conf.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: form
    }).then(r => r.json()).catch(() => null);
    const at = tr && tr.access_token;
    if (!at) return back('token');

    const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + at, Accept: 'application/json' }
    }).then(r => r.json()).catch(() => null);
    if (!info || !info.email || info.email_verified === false) return back('email');
    const email = normalizeEmail(info.email);

    let user = this.accountByEmail(email);
    if (!user){
      user = this.usernameFromEmail(email, info.name || '');
      const { hash, salt } = await hashPass(randHex(12));
      this.accounts.set(user, {
        hash, salt, email, coins: 0, lastCheckin: '', streak: 0,
        owned: [], skin: 'classic', strikes: 0, muteUntil: 0
      });
      this.scheduleSave();
    }
    const ticket = randHex(18);
    this.oauthTickets.set(ticket, { user, exp: Date.now() + 60 * 1000 });
    return Response.redirect(ret + (ret.includes('?') ? '&' : '?') + 'oauthCode=' + ticket, 302);
  }

  isGuest(u){ return this.guests.has(u); }
  skinOf(u){
    const a = this.accounts.get(u);
    return SKIN_MAP.get(a && a.skin) || SKINS[0];
  }
  colorOf(u){ return this.skinOf(u).color; }
  newToken(user){
    const t = [...randomBytes(24)].map(b => b.toString(16).padStart(2,'0')).join('');
    this.tokens.set(t, user);
    return t;
  }
  updateScore(user, score){
    if (!user || !score || this.isGuest(user)) return;
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

    const oauthResp = await this.handleOauth(request, url);
    if (oauthResp) return oauthResp;

    if (request.method === 'POST' && urlPath === '/api/register'){
      const body = await readBody(request);
      if (!body) return sendJSON(400, {ok:false,msg:'请求格式错误'});
      const u = String(body.u||'').trim();
      const p = String(body.p||'');
      if (!u || u.length>16 || /[^\w\u4e00-\u9fa5]/.test(u)) return sendJSON(400,{ok:false,msg:'用户名 1-16 字，只允许字母/数字/中文'});
      if (p.length<4 || p.length>32) return sendJSON(400,{ok:false,msg:'密码 4-32 位'});
      if (this.accounts.has(u)) return sendJSON(409,{ok:false,msg:'用户名已存在'});
      const email = normalizeEmail(body.email || '');
      if (this.mailReady()){
        if (!EMAIL_RE.test(email)) return sendJSON(400,{ok:false,msg:'请填写正确的邮箱'});
        const ent = this.mailCodes.get(email);
        const given = String(body.code || '').trim();
        if (!ent || ent.exp < Date.now() || ent.kind !== 'register' || ent.code !== given)
          return sendJSON(400,{ok:false,msg:'邮箱验证码不对或已过期', key:'codeWrong'});
        this.mailCodes.delete(email);
      }
      if (email && this.accountByEmail(email)) return sendJSON(409,{ok:false,msg:'这个邮箱已经注册过账号了'});
      const { hash, salt } = await hashPass(p);
      this.accounts.set(u, {
        hash, salt, email,
        coins: 0, lastCheckin: '', streak: 0, owned: [], skin: 'classic',
        strikes: 0, muteUntil: 0, oauth: ''
      });
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

    // ——— 邮件验证码 ———
    if (request.method === 'GET' && urlPath === '/api/mail-status'){
      if (!this.mailReady()){
        // 故意回非 JSON：前端会判成「未知」，从而隐藏验证码框，允许免验证码注册
        return new Response('mail disabled', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      return sendJSON(200, { ok:true, configured:true, provider:'brevo', from: (this.env && this.env.MAIL_FROM) || '' });
    }

    // 注册场景：给尚未注册的邮箱发码
    if (request.method === 'POST' && urlPath === '/api/send-code'){
      const body = await readBody(request);
      if (!body) return sendJSON(400, { ok:false, msg:'请求格式错误' });
      const email = normalizeEmail(body.email || '');
      const u = String(body.u || '').trim();
      if (!EMAIL_RE.test(email)) return sendJSON(400, { ok:false, msg:'邮箱格式不对' });
      if (!this.mailReady()) return sendJSON(503, { ok:false, msg:'邮件服务还没配置，先免验证码注册吧', key:'mailOff' });
      if (this.accountByEmail(email)) return sendJSON(409, { ok:false, msg:'这个邮箱已经注册过账号了' });
      const last = this.mailCooldowns.get('reg:' + email) || 0;
      if (Date.now() - last < 60 * 1000)
        return sendJSON(429, { ok:false, msg:'发太频繁了，' + Math.ceil((60 * 1000 - (Date.now() - last)) / 1000) + ' 秒后再试' });
      const code = await this.issueCode(email, 'register', u);
      const sent = await this.sendMail(email, '联机贪吃蛇 · 注册验证码',
        '<p>你的验证码是 <b style="font-size:22px;letter-spacing:2px">' + code + '</b>，10 分钟内有效。</p><p>不是你本人操作就忽略这封邮件。</p>');
      if (!sent) return sendJSON(502, { ok:false, msg:'邮件发送失败，检查 Brevo 的 key 和发件人验证', key:'mailFail' });
      this.mailCooldowns.set('reg:' + email, Date.now());
      return sendJSON(200, { ok:true, msg:'验证码已发到 ' + email });
    }

    // 重置密码：第 1 步发码（按当前登录账号绑定的邮箱）
    if (request.method === 'POST' && urlPath === '/api/reset_code'){
      const u = authFromReq(this, request);
      if (!u) return sendJSON(401, { ok:false, msg:'请先登录' });
      if (this.isGuest(u)) return sendJSON(403, { ok:false, msg:'游客没有绑定邮箱，不能重置密码' });
      const a = this.accounts.get(u);
      const email = a && a.email;
      if (!email) return sendJSON(400, { ok:false, msg:'这个账号没有绑定邮箱，无法重置密码' });
      if (!this.mailReady()) return sendJSON(503, { ok:false, msg:'邮箱服务还没配置', key:'mailOff' });
      const key = 'reset:' + u;
      const last = this.mailCooldowns.get(key) || 0;
      if (Date.now() - last < 60 * 1000)
        return sendJSON(429, { ok:false, msg:'发太频繁了，' + Math.ceil((60 * 1000 - (Date.now() - last)) / 1000) + ' 秒后再试' });
      const code = await this.issueCode(email, 'reset', u);
      const sent = await this.sendMail(email, '联机贪吃蛇 · 重置密码验证码',
        '<p>你的重置验证码是 <b style="font-size:22px;letter-spacing:2px">' + code + '</b>，10 分钟内有效。</p>');
      if (!sent) return sendJSON(502, { ok:false, msg:'邮件发送失败，检查 Brevo 的 key 和发件人验证', key:'mailFail' });
      this.mailCooldowns.set(key, Date.now());
      return sendJSON(200, { ok:true, msg:'验证码已发到你的邮箱' });
    }

    // 重置密码：第 2 步验码改密码
    if (request.method === 'POST' && urlPath === '/api/reset_pass'){
      const u = authFromReq(this, request);
      if (!u) return sendJSON(401, { ok:false, msg:'请先登录' });
      const body = await readBody(request);
      if (!body) return sendJSON(400, { ok:false, msg:'请求格式错误' });
      const a = this.accounts.get(u);
      if (!a) return sendJSON(400, { ok:false, msg:'账号不存在' });
      const ent = a.email ? this.mailCodes.get(a.email) : null;
      const given = String(body.code || '').trim();
      if (!ent || ent.exp < Date.now() || ent.kind !== 'reset' || ent.code !== given)
        return sendJSON(400, { ok:false, msg:'验证码不对或已过期', key:'codeWrong' });
      const p = String(body.pass || '');
      if (p.length < 4 || p.length > 32) return sendJSON(400, { ok:false, msg:'密码 4-32 位' });
      const { hash, salt } = await hashPass(p);
      a.hash = hash; a.salt = salt;
      this.mailCodes.delete(a.email);
      await this.persist();
      return sendJSON(200, { ok:true, msg:'密码已更新' });
    }

    // 改名：同时改账号键、token 归属、排行榜条目
    if (request.method === 'POST' && urlPath === '/api/rename'){
      const me = authFromReq(this, request);
      if (!me) return sendJSON(401, { ok:false, msg:'请先登录' });
      if (this.isGuest(me)) return sendJSON(403, { ok:false, msg:'游客不能改名，注册账号后才可以' });
      if (me === OFFICIAL_NAME) return sendJSON(403, { ok:false, msg:'官方账号不能改名' });
      const body = await readBody(request);
      if (!body) return sendJSON(400, { ok:false, msg:'请求格式错误' });
      const nu = String(body.name || '').trim();
      if (!nu || nu.length > 16 || /[^\w\u4e00-\u9fa5]/.test(nu))
        return sendJSON(400, { ok:false, msg:'用户名 1-16 字，只允许字母/数字/中文' });
      if (nu === me) return sendJSON(400, { ok:false, msg:'和现在的名字一样' });
      if (this.accounts.has(nu)) return sendJSON(409, { ok:false, msg:'用户名已存在' });
      if (this.guests.has(nu)) return sendJSON(409, { ok:false, msg:'这个名字正被游客使用，换一个吧' });
      const a = this.accounts.get(me);
      this.accounts.delete(me);
      this.accounts.set(nu, a);
      for (const [t, v] of this.tokens) if (v === me) this.tokens.set(t, nu);
      for (const it of this.leaderboard) if (it.u === me) it.u = nu;
      for (const sock of this.loggedInSockets) if (sock.user === me) sock.user = nu;
      await this.persist();
      return sendJSON(200, { ok:true, user:nu });
    }

    // 游客登录：一发就用，不写账号，成绩不进排行榜
    if (request.method === 'POST' && urlPath === '/api/guest'){
      let u = '';
      for (let i = 0; i < 50; i++){
        const n = '游客' + (Math.floor(Math.random()*9000)+1000);
        if (!this.accounts.has(n) && !this.guests.has(n)){ u = n; break; }
      }
      if (!u) u = '游客' + Date.now().toString().slice(-6);
      this.guests.add(u);
      const token = this.newToken(u);
      this.scheduleSave();
      return sendJSON(200, { ok:true, token, user:u, guest:true, muteLeft:0 });
    }

    // 前端探测：邮件服务、hCaptcha、OAuth 在本 Worker 版里全部关闭
    if (request.method === 'GET' && urlPath === '/api/config'){
      return sendJSON(200, {
        ok:true,
        siteKey:'', captchaRequired:false,
        officialCodeReady:false,
        oauthBase: this.siteOrigin(),
        oauth:{ microsoft:false, google:this.oauthReady('google'), github:false },
        sms:false
      });
    }

    if (request.method === 'GET' && urlPath === '/api/platform'){
      const ua = String(request.headers.get('User-Agent') || '');
      let platform = '';
      if (/Android/i.test(ua)) platform = 'android';
      else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'ios';
      else if (/Windows NT|Win64|WOW64|WindowsPhone/i.test(ua)) platform = 'win';
      else if (/Macintosh|Mac OS X/i.test(ua)) platform = 'mac';
      else if (/CrOS/i.test(ua)) platform = 'linux';
      else if (/Linux|X11/i.test(ua)) platform = 'linux';
      return sendJSON(200, { ok:true, platform, ua: ua.slice(0,240) });
    }

    // 浏览器里没有 httpOnly Cookie 可换，这里只回未登录
    if (request.method === 'POST' && urlPath === '/api/token'){
      const u = authFromReq(this, request);
      if (!u) return sendJSON(401, { ok:false, msg:'未登录' });
      const token = this.newToken(u);
      this.scheduleSave();
      return sendJSON(200, { ok:true, token, user:u, muteLeft:0, guest:this.isGuest(u) });
    }

    // 在线人数 / 玩家列表
    if (request.method === 'GET' && urlPath === '/api/players'){
      const me = authFromReq(this, request);
      if (!me) return sendJSON(401, { ok:false, msg:'未登录' });
      const online = new Set([...this.loggedInSockets].map(s => s.user).filter(Boolean));
      const best = new Map(this.leaderboard.map(x => [x.u, x.s]));
      const items = [...this.accounts.keys()].filter(u => u !== me).map(u => ({
        u, best: best.get(u) || 0, online: online.has(u), relation: '', off: u === OFFICIAL_NAME
      })).sort((a,b) => (b.online - a.online) || a.u.localeCompare(b.u, 'zh'));
      return sendJSON(200, { ok:true, items, count: online.size });
    }

    // 好友 / 群组：本版还没搬，先回空列表，前端不会报错
    if (request.method === 'GET' && urlPath === '/api/friends'){
      return sendJSON(200, { ok:true, friends:[], requests:[] });
    }
    if (urlPath.startsWith('/api/friend/') || urlPath.startsWith('/api/group/')){
      return sendJSON(200, { ok:false, msg:'好友和群组功能还没搬到 Cloudflare 版', friends:[], requests:[], groups:[], items:[], msgs:[] });
    }

    // ——— 皮肤商店（和 Node 版同一套规则） ———
    if (request.method === 'GET' && urlPath === '/api/shop'){
      const u = authFromReq(this, request);
      if (!u) return sendJSON(401, { ok:false, msg:'未登录' });
      if (this.isGuest(u)) return sendJSON(200, { ok:true, guest:true, coins:0, skin:'classic', owned:[], checkedToday:false, streak:0, skins:SKINS });
      const a = this.accounts.get(u);
      const today = dayKey();
      return sendJSON(200, {
        ok:true, guest:false,
        coins: a.coins || 0,
        skin: a.skin || 'classic',
        owned: ownedSkinsOf(u, a),
        streak: a.lastCheckin ? (a.streak || 0) : 0,
        checkedToday: a.lastCheckin === today,
        skins: SKINS
      });
    }

    if (request.method === 'POST' && urlPath === '/api/shop/checkin'){
      const u = authFromReq(this, request);
      if (!u) return sendJSON(401, { ok:false, msg:'未登录' });
      if (this.isGuest(u)) return sendJSON(403, { ok:false, msg:'游客不能领金币，注册个账号再来', key:'guestNoCoin' });
      const a = this.accounts.get(u);
      const today = dayKey();
      if (a.lastCheckin === today) return sendJSON(400, { ok:false, msg:'今天已经签到过了，明天再来', key:'checkedToday', coins:a.coins || 0 });
      const streak = a.lastCheckin === prevDayKey(today) ? (a.streak || 0) + 1 : 1;
      const reward = checkinReward(streak);
      a.streak = streak; a.lastCheckin = today; a.coins = (a.coins || 0) + reward;
      this.scheduleSave();
      return sendJSON(200, { ok:true, reward, coins:a.coins, streak, checkedToday:true });
    }

    if (request.method === 'POST' && urlPath === '/api/shop/buy'){
      const u = authFromReq(this, request);
      if (!u) return sendJSON(401, { ok:false, msg:'未登录' });
      if (this.isGuest(u)) return sendJSON(403, { ok:false, msg:'游客不能买皮肤，注册个账号再来', key:'guestNoSkin' });
      const body = await request.json().catch(() => null);
      if (!body) return sendJSON(400, { ok:false, msg:'请求格式错误' });
      const sk = SKIN_MAP.get(body.id);
      if (!sk) return sendJSON(404, { ok:false, msg:'没有这个皮肤' });
      const a = this.accounts.get(u);
      a.owned = a.owned || [];
      if (u === OFFICIAL_NAME) return sendJSON(400, { ok:false, msg:'官方账号皮肤全部解锁，直接换就行', key:'officialAllSkins' });
      if (a.owned.includes(sk.id) || sk.id === 'classic') return sendJSON(400, { ok:false, msg:'这个皮肤你已经有了', key:'alreadyOwned' });
      if ((a.coins || 0) < sk.price) return sendJSON(400, { ok:false, msg:'金币不够，还差 ' + (sk.price - (a.coins || 0)) + ' 个', key:'noEnoughCoins' });
      a.coins = (a.coins || 0) - sk.price;
      a.owned.push(sk.id);
      a.skin = sk.id;
      this.scheduleSave();
      return sendJSON(200, { ok:true, coins:a.coins, skin:a.skin, owned:a.owned });
    }

    if (request.method === 'POST' && urlPath === '/api/shop/equip'){
      const u = authFromReq(this, request);
      if (!u) return sendJSON(401, { ok:false, msg:'未登录' });
      const body = await request.json().catch(() => null);
      if (!body) return sendJSON(400, { ok:false, msg:'请求格式错误' });
      const sk = SKIN_MAP.get(body.id);
      if (!sk) return sendJSON(404, { ok:false, msg:'没有这个皮肤' });
      const a = this.accounts.get(u) || {};
      if (!ownedSkinsOf(u, a).includes(sk.id)) return sendJSON(403, { ok:false, msg:'还没买这个皮肤', key:'notOwned' });
      a.skin = sk.id;
      if (!this.isGuest(u)) { this.accounts.set(u, a); this.scheduleSave(); }
      return sendJSON(200, { ok:true, skin:sk.id });
    }

    if (request.method === 'GET' && urlPath === '/api/me'){
      const u = authFromReq(this, request);
      if (!u) return sendJSON(401, {ok:false,msg:'未登录'});
      const score = this.leaderboard.find(x=>x.u===u);
      return sendJSON(200, { ok:true, user:u, best: score ? score.s : 0,
        muteLeft:0, guest:this.isGuest(u), official: u === OFFICIAL_NAME });
    }

    if (request.method === 'GET' && urlPath === '/api/scores'){
      return sendJSON(200, {ok:true, items: this.leaderboard.slice(0,20)});
    }

    return sendJSON(404, {ok:false,msg:'未找到'});
  }
}
