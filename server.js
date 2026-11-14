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
const ai = require('./ai');   // 单人模式的豆包 AI
const mail = require('./mail'); // 注册验证码邮件

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
    accounts = new Map(raw.map(a => [a.u, { hash:a.h, salt:a.s, strikes:a.n||0, muteUntil:a.m||0, email:a.e||'', ip:a.i||'' }]));
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

// ============================================================
//  GitHub 加密云备份（存到仓库 save-data 分支，AES 加密，重启不丢账号；
//  需要环境变量 GH_TOKEN + BACKUP_KEY，本地不设则不启用）
// ============================================================
const GH_TOKEN = process.env.GH_TOKEN || '';
const BACKUP_KEY = process.env.BACKUP_KEY || '';
const GH_REPO = process.env.GH_REPO || 's2ys9jgn4d-star/snake-online';
const BACKUP_BRANCH = 'save-data';
const BACKUP_FILE = 'save-data.enc.json';

function encryptBackup(plain){
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(BACKUP_KEY, salt, 32, { cost: 16384, blockSize: 8, parallelization: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString('base64');
}
function decryptBackup(b64){
  const raw = Buffer.from(b64, 'base64');
  const salt = raw.subarray(0, 16), iv = raw.subarray(16, 28), tag = raw.subarray(28, 44);
  const key = crypto.scryptSync(BACKUP_KEY, salt, 32, { cost: 16384, blockSize: 8, parallelization: 1 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(44)), decipher.final()]).toString('utf8');
}
function ghHeaders(){
  return { 'Authorization': 'Bearer ' + GH_TOKEN, 'Accept': 'application/vnd.github+json', 'User-Agent': 'snake-online' };
}

// 启动时从 save-data 分支恢复（仅本地数据为空时才覆盖；设 FORCE_RESTORE=1 则强制覆盖）
async function cloudRestore(){
  if (!GH_TOKEN || !BACKUP_KEY) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${BACKUP_FILE}?ref=${BACKUP_BRANCH}`, { headers: ghHeaders() });
    if (!res.ok) { console.log('云备份恢复：暂无备份（HTTP ' + res.status + '）'); return; }
    const j = await res.json();
    const payload = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    const plain = JSON.parse(decryptBackup(payload.data));
    const force = !!process.env.FORCE_RESTORE;
    if (plain.users && (accounts.size === 0 || force)){ fs.writeFileSync(USERS_FILE, plain.users); loadUsers(); }
    if (plain.scores && (leaderboard.length === 0 || force)){ fs.writeFileSync(SCORES_FILE, plain.scores); loadScores(); }
    if (plain.friends && (!fs.existsSync(FRIENDS_FILE) || force)){ fs.writeFileSync(FRIENDS_FILE, plain.friends); loadSocial(); }
    if (plain.banned && (!fs.existsSync(BANNED_FILE) || force)){ fs.writeFileSync(BANNED_FILE, plain.banned); loadBanned(); }
    console.log('云备份恢复完成：' + accounts.size + ' 个账号，' + leaderboard.length + ' 条分数' + (force ? '（强制恢复）' : ''));
  } catch (e) { console.log('云备份恢复出错：' + e.message); }
}

// 每次保存后 5 秒防抖，加密推送到 save-data 分支
let backupTimer = null;
function cloudBackup(){
  if (!GH_TOKEN || !BACKUP_KEY) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    try {
      const plain = JSON.stringify({
        users: fs.existsSync(USERS_FILE) ? fs.readFileSync(USERS_FILE, 'utf8') : '[]',
        scores: fs.existsSync(SCORES_FILE) ? fs.readFileSync(SCORES_FILE, 'utf8') : '[]',
        friends: fs.existsSync(FRIENDS_FILE) ? fs.readFileSync(FRIENDS_FILE, 'utf8') : null,
        banned: fs.existsSync(BANNED_FILE) ? fs.readFileSync(BANNED_FILE, 'utf8') : null
      });
      const content = Buffer.from(JSON.stringify({ v: 1, data: encryptBackup(plain) })).toString('base64');
      const api = `https://api.github.com/repos/${GH_REPO}/contents/${BACKUP_FILE}`;
      let sha;
      const cur = await fetch(api + '?ref=' + BACKUP_BRANCH, { headers: ghHeaders() });
      if (cur.ok) sha = (await cur.json()).sha;
      const body = { message: 'backup ' + new Date().toISOString(), content, branch: BACKUP_BRANCH };
      if (sha) body.sha = sha;
      const put = await fetch(api, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
      if (!put.ok) console.log('云备份推送失败：HTTP ' + put.status);
    } catch {}
  }, 5000);
}

function saveUsers(){ atomicWrite(USERS_FILE, [...accounts.entries()].map(([u,a])=>({u, h:a.hash, s:a.salt, n:a.strikes||0, m:a.muteUntil||0, e:a.email||'', i:a.ip||''}))); cloudBackup(); }
function saveScores(){ atomicWrite(SCORES_FILE, leaderboard); cloudBackup(); }

// ============================================================
//  注册验证码（只存在内存里，10 分钟过期，服务器重启就失效）
// ============================================================
const emailCodes = new Map();     // email -> { code, exp }
const codeCooldown = new Map();   // email -> 上次发送时间
const CODE_TTL = 10 * 60 * 1000;
const CODE_GAP = 60 * 1000;
// 邮箱格式：用户名@域名.后缀，比如 abc@example.com
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
function normalizeEmail(s){ return String(s || '').trim().toLowerCase(); }

// 发信刚失败过就先认为邮箱不可用（10 分钟后自动重试），期间注册不强制验证码
let mailBrokenUntil = 0;
const MAIL_BROKEN_MS = 10 * 60 * 1000;
// 邮箱验证码：REQUIRE_EMAIL_CODE=0 强制关；配了 HTTPS 发信接口自动开；只有 SMTP 时要 =1 才开
const REQUIRE_EMAIL_CODE = process.env.REQUIRE_EMAIL_CODE;
function mailUsable(){
  if (REQUIRE_EMAIL_CODE === '0') return false;
  if (Date.now() < mailBrokenUntil) return false;
  if (mail.apiConfig()) return true;
  return REQUIRE_EMAIL_CODE === '1' && mail.isConfigured();
}

// —— 图片验证码：不依赖任何外部服务，4 个字符，10 分钟有效 ——
const captchas = new Map();
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function captchaSvg(code){
  const w = 120, h = 40;
  let noise = '';
  for (let i = 0; i < 5; i++){
    const x1 = (Math.random()*w)|0, y1 = (Math.random()*h)|0;
    const x2 = (Math.random()*w)|0, y2 = (Math.random()*h)|0;
    noise += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#9aa6b2" stroke-width="1" opacity=".55"/>';
  }
  let chars = '';
  code.split('').forEach((ch, i) => {
    const x = 16 + i * 25, y = 28, rot = (Math.random()*24 - 12).toFixed(0);
    chars += '<text x="' + x + '" y="' + y + '" font-size="24" font-family="monospace" font-weight="bold" fill="#1f2937" transform="rotate(' + rot + ' ' + x + ' ' + y + ')">' + ch + '</text>';
  });
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><rect width="100%" height="100%" fill="#eef2f7"/>' + noise + chars + '</svg>';
}
function newCaptcha(){
  for (const [k, v] of captchas) if (v.exp < Date.now()) captchas.delete(k);
  let code = '';
  for (let i = 0; i < 4; i++) code += CAPTCHA_CHARS[crypto.randomInt(CAPTCHA_CHARS.length)];
  const id = crypto.randomBytes(8).toString('hex');
  captchas.set(id, { code, exp: Date.now() + 10 * 60 * 1000 });
  return { id, svg: captchaSvg(code) };
}
function checkCaptcha(id, text){
  const rec = captchas.get(id);
  if (!rec) return false;
  captchas.delete(id);
  if (rec.exp < Date.now()) return false;
  return String(text || '').trim().toUpperCase() === rec.code;
}

// ============================================================
//  好友：关系 / 申请 / 私聊记录（存 data/friends.json，重启不丢）
//  friends[我] = [好友名...]
//  reqs[我]    = [{from, ts}]        —— 别人发给我、还没处理的申请
//  msgs['a|b'] = [{from, text, ts}]  —— 两个人的私聊记录（最多 100 条）
// ============================================================
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
let social = { friends:{}, reqs:{}, msgs:{} };
function loadSocial(){
  try {
    const raw = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
    social = { friends: raw.friends || {}, reqs: raw.reqs || {}, msgs: raw.msgs || {} };
  } catch { social = { friends:{}, reqs:{}, msgs:{} }; }
}
loadSocial();
function saveSocial(){ atomicWrite(FRIENDS_FILE, social); }
function pairKey(a, b){ return [a, b].sort().join('|'); }
function friendListOf(u){ return social.friends[u] || []; }
function areFriends(a, b){ return friendListOf(a).includes(b); }
function addFriendPair(a, b){
  social.friends[a] = social.friends[a] || [];
  social.friends[b] = social.friends[b] || [];
  if (!social.friends[a].includes(b)) social.friends[a].push(b);
  if (!social.friends[b].includes(a)) social.friends[b].push(a);
}
// 账号注销时，把它从别人的好友/申请/聊天里摘干净
function cleanupSocial(u){
  for (const k of Object.keys(social.friends)){
    social.friends[k] = social.friends[k].filter(x => x !== u);
    if (!social.friends[k].length) delete social.friends[k];
  }
  for (const k of Object.keys(social.reqs)){
    social.reqs[k] = social.reqs[k].filter(r => r.from !== u);
    if (!social.reqs[k].length) delete social.reqs[k];
  }
  for (const k of Object.keys(social.msgs)) if (k.split('|').includes(u)) delete social.msgs[k];
  saveSocial();
}
// ============================================================
//  黑名单：封号时记下邮箱和注册 IP，禁止再用同一邮箱/IP 注册
// ============================================================
const BANNED_FILE = path.join(DATA_DIR, 'banned.json');
let banned = { emails: [], ips: [] };
function loadBanned(){
  try {
    const raw = JSON.parse(fs.readFileSync(BANNED_FILE, 'utf8'));
    banned = { emails: raw.emails || [], ips: raw.ips || [] };
  } catch { banned = { emails: [], ips: [] }; }
}
loadBanned();
function saveBanned(){ try { atomicWrite(BANNED_FILE, banned); } catch (e) { console.log('黑名单保存失败：' + e.message); } }
// 封号时调用：把该账号的邮箱和注册 IP 拉黑
function banAccount(a, ip){
  if (a && a.email && !banned.emails.includes(a.email)) banned.emails.push(a.email);
  const realIp = ip || (a && a.ip);
  if (realIp && !banned.ips.includes(realIp)) banned.ips.push(realIp);
  saveBanned();
}
// 注册前检查：命中黑名单就返回提示文字，没命中返回空串
function bannedHit(email, ip){
  if (email && banned.emails.includes(email)) return '这个邮箱以前有账号因违规被封，不能再注册了';
  if (ip && banned.ips.includes(ip)) return '这个网络下有账号因违规被封，换个网络试试，或联系管理员';
  return '';
}
function clientIp(req){
  const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return f || (req.socket && req.socket.remoteAddress) || '';
}

// 我和某人的关系：friend 好友 / outgoing 我已申请 / incoming 他申请了我 / '' 陌生人
function relationOf(me, other){
  if (areFriends(me, other)) return 'friend';
  if ((social.reqs[me] || []).some(r => r.from === other)) return 'incoming';
  if ((social.reqs[other] || []).some(r => r.from === me)) return 'outgoing';
  return '';
}
function bestOf(u){ const s = leaderboard.find(x => x.u === u); return s ? s.s : 0; }

// 在线连接：同一个账号可能电脑和手机同时开着
const socketsByUser = new Map();
function isOnline(u){ return socketsByUser.has(u); }
function addSocket(ws){
  let set = socketsByUser.get(ws.user);
  if (!set){ set = new Set(); socketsByUser.set(ws.user, set); }
  set.add(ws);
  if (set.size === 1) notifyFriendsPresence(ws.user, true);
}
function removeSocket(ws){
  const set = socketsByUser.get(ws.user);
  if (!set) return;
  set.delete(ws);
  if (!set.size){ socketsByUser.delete(ws.user); notifyFriendsPresence(ws.user, false); }
}
function pushToUser(u, obj){
  const set = socketsByUser.get(u);
  if (!set) return;
  const s = JSON.stringify(obj);
  for (const ws of set) ws.sendText(s);
}
function notifyFriendsPresence(u, online){
  for (const f of friendListOf(u)) pushToUser(f, { t:'presence', user:u, online });
}

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
    this.isSolo = false;      // 单人房：不显示在房间列表里，别人也进不来
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
    // 豆包 AI：单人模式的电脑对手
    for (const p of this.players.values()){
      if (!p.isBot) continue;
      if (!p.alive){
        // 撞死了就等 2 秒复活，否则单人房会变成空房
        const now = Date.now();
        if (!p.botRespawnAt) p.botRespawnAt = now + 2000;
        else if (now >= p.botRespawnAt){
          p.botRespawnAt = 0;
          this.resetPlayer(p);
          this.broadcast(JSON.stringify({t:'chat', from:'系统', text:'豆包 复活了'}));
        }
        continue;
      }
      const d = ai.decide(this, p, COLS, ROWS);
      if (d) p.dir = d;
    }
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
        if (!p.isBot) updateScore(p.name, p.score); // 死亡时持久化分数（机器人不上榜）
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

  // 只有房主能改，且 5 秒内只能改一次：防止有人（脚本/扩展/连点）反复抢着调速度
  setSpeed(ms, by){
    const v = Math.round(Number(ms));
    if (!Number.isFinite(v)) return { ok:false, msg:'速度值无效' };
    if (by !== this.owner) return { ok:false, msg:'只有房主能调速度，你可以自己开一个房间' };
    const now = Date.now();
    if (now - (this.lastSpeedAt || 0) < 5000) return { ok:false, msg:'调得太频繁了，等几秒再试' };
    this.lastSpeedAt = now;
    this.tickMs = Math.min(500, Math.max(50, v));
    clearInterval(this.timer);
    this.timer = setInterval(() => this.step(), this.tickMs);
    return { ok:true };
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
  // 单人模式的电脑对手：没有真 socket，用一个空壳占位
  addBot(username){
    const id = this.nextPlayerId++;
    const stub = { sendText(){}, ping(){}, close(){}, lastSeen: Infinity, playerId: id, room: this };
    const p = {
      id, ws: stub, name: username, color: COLORS[(id-1)%COLORS.length],
      body:[], queue:[], dir:'right', alive:false, score:0, deathReason:'', newHead:null,
      isBot: true
    };
    this.resetPlayer(p);
    this.players.set(id, p);
    this.broadcast(JSON.stringify({t:'chat', from:'系统', text:username+' 加入了房间'}));
    return p;
  }

  removePlayer(player){
    this.players.delete(player.id);
    this.broadcast(JSON.stringify({t:'chat', from:'系统', text:player.name+' 离开了房间'}));
    this.broadcastState();
    // 单人房：真人走了就整间销毁，别留一个空房间给豆包自己玩
    if (this.isSolo && ![...this.players.values()].some(p => !p.isBot)){
      this.destroy();
      rooms.delete(this.id);
      broadcastRooms();
    }
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
  const list = [...rooms.values()].filter(r => !r.isSolo).map(r => ({
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

// 大厅聊天记录（只留最近 50 条，新进来的人也能看到刚才在聊什么）
const LOBBY_HISTORY_MAX = 50;
const lobbyHistory = [];

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

// ============================================================
//  违禁词过滤
//  中英文词表分开：中文按包含匹配，英文要求前后不是字母数字（避免 abs 里的 sb 被误伤）
//  词与词之间允许插空格、标点、零宽字符，防止用「傻 逼」「傻.逼」绕过
// ============================================================
const BANNED_CJK = [
  '傻逼','煞笔','沙比','傻b','草泥马','操你妈','草你妈','你妈死了','你妈的','妈的',
  '他妈','去死','滚蛋','废物','智障','脑残','狗东西','杂种','贱人','死全家','垃圾东西'
];
const BANNED_EN = [
  'fuck','fucking','shit','bitch','asshole','dick','pussy','nmsl','cnm','tmd','mdzz','sb'
];
const BANNED_SEP = '[\\s\\p{P}\\p{S}\\u200b-\\u200f\\ufeff]*';

function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 把每个词拆成单字，中间允许夹填空隙，再拼成一条正则
function buildBannedRegExp(words, ascii){
  const body = words.map(w => [...w].map(escapeRe).join(BANNED_SEP)).join('|');
  return ascii
    ? new RegExp('(?<![A-Za-z0-9])(?:' + body + ')(?![A-Za-z0-9])', 'giu')
    : new RegExp('(?:' + body + ')', 'gu');
}
const BANNED_CJK_RE = buildBannedRegExp(BANNED_CJK, false);
const BANNED_EN_RE  = buildBannedRegExp(BANNED_EN, true);

// 有没有违禁词
function hasBannedWord(text){
  const s = String(text || '');
  BANNED_CJK_RE.lastIndex = 0; BANNED_EN_RE.lastIndex = 0;
  return BANNED_CJK_RE.test(s) || BANNED_EN_RE.test(s);
}

// ============================================================
//  违禁词处罚：第 1 次禁言 24 小时 → 第 2 次禁言 7 天 → 第 3 次直接注销
//  记过次数和禁言到期时间存在 accounts 里，跟着 users.json 一起备份，重启不丢
// ============================================================
const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

function fmtLeft(ms){
  const hours = Math.ceil(ms / 3600000);
  return hours <= 24 ? hours + ' 小时' : Math.ceil(hours / 24) + ' 天';
}

// 还要被禁言多久（0 = 没在禁言）
function muteLeftOf(user){
  const a = accounts.get(user);
  if (!a || !a.muteUntil) return 0;
  const left = a.muteUntil - Date.now();
  return left > 0 ? left : 0;
}

// 把某个用户的所有连接踢下线
function kickUser(user, text){
  for (const s of loggedInSockets){
    if (s.user === user){
      s.sendText(JSON.stringify({t:'sys', msg:text}));
      s.close();
    }
  }
}

// 记一次过并处罚，返回给当事人看的提示；账号不存在返回 null
function punishBannedWord(user){
  const a = accounts.get(user);
  if (!a) return null;
  a.strikes = (a.strikes || 0) + 1;

  if (a.strikes >= 3){
    banAccount(a);           // 拉黑邮箱和注册 IP，防止换个用户名再来
    accounts.delete(user);
    saveUsers();
    cleanupSocial(user);
    leaderboard = leaderboard.filter(x => x.u !== user);
    saveScores();
    for (const [t, u2] of [...tokens.entries()]) if (u2 === user) tokens.delete(t);
    kickUser(user, '你已 3 次发送违禁词，账号已被注销');
    return '你已 3 次发送违禁词，账号已被注销';
  }

  const dur = a.strikes === 1 ? DAY_MS : WEEK_MS;
  a.muteUntil = Date.now() + dur;
  saveUsers();
  return '你发送了违禁词，已被禁言 ' + fmtLeft(dur) + '（第 ' + a.strikes + ' 次，第 3 次将注销账号）';
}

// 发聊天前的检查：禁言中拦下；含违禁词则处罚。返回 true 表示这条不该广播
function blockChatIfNeeded(ws, text){
  const left = muteLeftOf(ws.user);
  if (left > 0){
    ws.sendText(JSON.stringify({t:'sys', msg:'你正在禁言中，还需等待 ' + fmtLeft(left)}));
    return true;
  }
  if (hasBannedWord(text)){
    const msg = punishBannedWord(ws.user);
    if (msg) ws.sendText(JSON.stringify({t:'sys', msg}));
    return true;
  }
  return false;
}

// ============================================================
//  管理员（密码解锁，可注销账号）
// ============================================================
const ADMIN_PASS = process.env.ADMIN_PASS || '0326';
const adminSessions = new Set();   // 登录成功后发的临时令牌

function isAdmin(req){
  const t = String(req.headers['x-admin-token'] || '').trim();
  return !!t && adminSessions.has(t);
}

async function handleApi(req, res, urlPath){
  if (req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }
  // 图片验证码：返回 {id, svg}，注册时把 id 和填的字一起提交
  if (req.method === 'GET' && urlPath === '/api/captcha'){
    const c = newCaptcha();
    return sendJSON(res, 200, { ok: true, id: c.id, svg: c.svg });
  }
  // 发送注册验证码：邮箱 → 6 位数字，10 分钟有效
  if (req.method === 'POST' && urlPath === '/api/send-code'){
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const email = normalizeEmail(body.email);
    const u = String(body.u||'').trim();
    if (!EMAIL_RE.test(email)) return sendJSON(res, 400, {ok:false,msg:'邮箱格式不对，要像 abc@example.com 这样'});
    if (u && accounts.has(u)) return sendJSON(res, 409, {ok:false,msg:'用户名已存在'});
    for (const a of accounts.values()) if (a.email === email) return sendJSON(res, 409, {ok:false,msg:'这个邮箱已经注册过账号了'});
    if (bannedHit(email, '')) return sendJSON(res, 403, {ok:false,msg:'这个邮箱以前有账号因违规被封，不能再注册了'});
    if (!mailUsable()){
      return sendJSON(res, 503, {ok:false, msg: Date.now() < mailBrokenUntil
        ? '邮箱服务刚出故障，暂时发不了验证码；不填邮箱也能直接注册'
        : '现在注册不需要邮箱验证码，直接填用户名和密码就行'});
    }
    const last = codeCooldown.get(email) || 0;
    if (Date.now() - last < CODE_GAP){
      return sendJSON(res, 429, {ok:false,msg:'发太频繁了，' + Math.ceil((CODE_GAP - (Date.now() - last)) / 1000) + ' 秒后再试'});
    }
    const code = String(100000 + randInt(900000));
    emailCodes.set(email, { code, exp: Date.now() + CODE_TTL });
    codeCooldown.set(email, Date.now());
    try {
      await mail.sendMail({
        to: email,
        subject: '联机贪吃蛇 · 注册验证码',
        text: '你的验证码是：' + code + '\n\n10 分钟内有效。\n如果不是你本人在注册，忽略这封邮件就好。'
      });
    } catch (e){
      emailCodes.delete(email);
      mailBrokenUntil = Date.now() + MAIL_BROKEN_MS;   // 10 分钟内不再强求验证码
      console.log('发验证码失败：' + e.message);
      return sendJSON(res, 500, {ok:false,msg:'邮件发送失败：' + e.message + '（这次直接用下面图片里的 4 个字符注册就行）'});
    }
    mailBrokenUntil = 0;
    return sendJSON(res, 200, {ok:true, msg:'验证码已发到邮箱，10 分钟内有效'});
  }
  if (req.method === 'POST' && urlPath === '/api/register'){
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const u = String(body.u||'').trim();
    const p = String(body.p||'');
    const email = normalizeEmail(body.email);
    const code = String(body.code||'').trim();
    if (!u || u.length>16 || /[^\w\u4e00-\u9fa5]/.test(u)) return sendJSON(res,400,{ok:false,msg:'用户名 1-16 字，只允许字母/数字/中文'});
    if (p.length<4 || p.length>32) return sendJSON(res,400,{ok:false,msg:'密码 4-32 位'});
    // 邮箱必填：即使发不了验证码也要填，用来追溯封号
    const needEmail = mailUsable();
    if (!EMAIL_RE.test(email)) return sendJSON(res,400,{ok:false,msg:'邮箱格式不对，要像 abc@example.com 这样'});
    if (hasBannedWord(u)) return sendJSON(res,400,{ok:false,msg:'用户名含有不允许的字词，换一个吧'});
    if (accounts.has(u)) return sendJSON(res,409,{ok:false,msg:'用户名已存在'});
    for (const a of accounts.values()) if (a.email === email) return sendJSON(res,409,{ok:false,msg:'这个邮箱已经注册过账号了'});
    const ip = clientIp(req);
    const hit = bannedHit(email, ip);
    if (hit) return sendJSON(res, 403, {ok:false, msg:hit});
    if (needEmail){
      const rec = emailCodes.get(email);
      if (!rec || rec.exp < Date.now() || rec.code !== code) return sendJSON(res,400,{ok:false,msg:'验证码不对或已过期，重新发一次'});
      emailCodes.delete(email);
    } else {
      // 没开邮箱验证时，用图片验证码兜底，防止机器人乱注册
      if (!checkCaptcha(String(body.cid||''), body.captcha)) return sendJSON(res,400,{ok:false,msg:'验证码不对，点「换一张」再试'});
    }
    const { hash, salt } = hashPass(p);
    accounts.set(u, { hash, salt, email, ip });
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
    return sendJSON(res, 200, {ok:true, token, user:u, muteLeft: muteLeftOf(u)});
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
    cleanupSocial(u);
    leaderboard = leaderboard.filter(x=>x.u!==u);
    saveScores();
    for (const [t, user] of [...tokens.entries()]) if (user===u) tokens.delete(t);
    return sendJSON(res, 200, {ok:true});
  }
  if (req.method === 'GET' && urlPath === '/api/me'){
    const u = authFromReq(req);
    if (!u) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const score = leaderboard.find(x=>x.u===u);
    return sendJSON(res, 200, {ok:true, user:u, best: score ? score.s : 0, muteLeft: muteLeftOf(u)});
  }
  if (req.method === 'GET' && urlPath === '/api/scores'){
    return sendJSON(res, 200, {ok:true, items: leaderboard.slice(0,20)});
  }
  // 邮箱发信自检：只报「有没有」不报值，方便排查线上配置
  if (req.method === 'GET' && urlPath === '/api/mail-status'){
    return sendJSON(res, 200, {
      ok: true,
      configured: mailUsable(),
      accounts: mail.accounts().length,
      env: {
        api: !!process.env.MAIL_API,
        apiKey: !!process.env.MAIL_API_KEY,
        provider: !!process.env.MAIL_PROVIDER,
        user: !!process.env.MAIL_USER,
        pass: !!process.env.MAIL_PASS,
        from: !!process.env.MAIL_FROM
      },
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
    });
  }

  // —— 好友 API ——
  // 所有玩家（带在线状态和我和他的关系）
  if (req.method === 'GET' && urlPath === '/api/players'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const items = [...accounts.keys()].filter(u => u !== me).map(u => ({
      u, best: bestOf(u), online: isOnline(u), relation: relationOf(me, u)
    })).sort((a,b) => (b.online - a.online) || a.u.localeCompare(b.u, 'zh'));
    return sendJSON(res, 200, {ok:true, items});
  }
  // 我的好友 + 待处理的好友申请
  if (req.method === 'GET' && urlPath === '/api/friends'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const friends = friendListOf(me).map(u => ({ u, online:isOnline(u), best:bestOf(u) }));
    const requests = (social.reqs[me] || []).map(r => ({ from:r.from, ts:r.ts }));
    return sendJSON(res, 200, {ok:true, friends, requests});
  }
  // 发好友申请（如果对方已经申请过我，就直接成为好友）
  if (req.method === 'POST' && urlPath === '/api/friend/request'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const to = String(body.to||'').trim();
    if (to === me) return sendJSON(res, 400, {ok:false,msg:'不能加自己'});
    if (!accounts.has(to)) return sendJSON(res, 404, {ok:false,msg:'没有这个玩家'});
    if (areFriends(me, to)) return sendJSON(res, 200, {ok:true, msg:'你们已经是好友了'});
    if ((social.reqs[me] || []).some(r => r.from === to)){
      social.reqs[me] = social.reqs[me].filter(r => r.from !== to);
      if (!social.reqs[me].length) delete social.reqs[me];
      addFriendPair(me, to);
      saveSocial();
      pushToUser(to, { t:'friend_accept', by: me });
      pushToUser(me, { t:'friend_accept', by: to });
      return sendJSON(res, 200, {ok:true, msg:'你们已经是好友了'});
    }
    if ((social.reqs[to] || []).some(r => r.from === me)) return sendJSON(res, 200, {ok:true, msg:'已经申请过了，等对方同意'});
    social.reqs[to] = social.reqs[to] || [];
    social.reqs[to].push({ from: me, ts: Date.now() });
    saveSocial();
    pushToUser(to, { t:'friend_request', from: me, ts: Date.now() });
    return sendJSON(res, 200, {ok:true, msg:'申请已发送'});
  }
  // 同意好友申请
  if (req.method === 'POST' && urlPath === '/api/friend/accept'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const from = String(body.from||'').trim();
    if (!(social.reqs[me] || []).some(r => r.from === from)) return sendJSON(res, 404, {ok:false,msg:'没有这条申请'});
    social.reqs[me] = social.reqs[me].filter(r => r.from !== from);
    if (!social.reqs[me].length) delete social.reqs[me];
    if (!accounts.has(from)){ saveSocial(); return sendJSON(res, 404, {ok:false,msg:'对方账号已经不在了'}); }
    addFriendPair(me, from);
    saveSocial();
    pushToUser(from, { t:'friend_accept', by: me });
    pushToUser(me, { t:'friend_accept', by: from });
    return sendJSON(res, 200, {ok:true, msg:'已加为好友'});
  }
  // 拒绝好友申请
  if (req.method === 'POST' && urlPath === '/api/friend/reject'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const from = String(body.from||'').trim();
    social.reqs[me] = (social.reqs[me] || []).filter(r => r.from !== from);
    if (!social.reqs[me].length) delete social.reqs[me];
    saveSocial();
    return sendJSON(res, 200, {ok:true, msg:'已拒绝'});
  }
  // 删除好友
  if (req.method === 'POST' && urlPath === '/api/friend/remove'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const u = String(body.u||'').trim();
    social.friends[me] = friendListOf(me).filter(x => x !== u);
    if (!social.friends[me].length) delete social.friends[me];
    social.friends[u] = friendListOf(u).filter(x => x !== me);
    if (!social.friends[u].length) delete social.friends[u];
    delete social.msgs[pairKey(me, u)];
    saveSocial();
    return sendJSON(res, 200, {ok:true, msg:'已删除好友'});
  }
  // 好友私聊记录（最近 100 条）
  if (req.method === 'POST' && urlPath === '/api/friend/history'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const withWho = String(body.with||'').trim();
    if (!areFriends(me, withWho)) return sendJSON(res, 403, {ok:false,msg:'你们还不是好友'});
    return sendJSON(res, 200, {ok:true, items: (social.msgs[pairKey(me, withWho)] || []).slice(-100)});
  }
  // 发私聊消息
  if (req.method === 'POST' && urlPath === '/api/friend/chat'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const to = String(body.to||'').trim();
    const text = String(body.text||'').trim().slice(0, 200);
    if (!text) return sendJSON(res, 400, {ok:false,msg:'不能发空消息'});
    if (!areFriends(me, to)) return sendJSON(res, 403, {ok:false,msg:'你们还不是好友'});
    const left = muteLeftOf(me);
    if (left > 0) return sendJSON(res, 403, {ok:false,msg:'你正在禁言中，还需等待 ' + fmtLeft(left)});
    if (hasBannedWord(text)){
      const m = punishBannedWord(me);
      if (m) pushToUser(me, {t:'sys', msg:m});
      return sendJSON(res, 400, {ok:false,msg: m || '消息含有不允许的字词'});
    }
    const k = pairKey(me, to);
    const arr = social.msgs[k] = social.msgs[k] || [];
    const item = { from: me, text, ts: Date.now() };
    arr.push(item);
    if (arr.length > 100) arr.splice(0, arr.length - 100);
    saveSocial();
    pushToUser(to, { t:'friend_msg', from: me, text, ts: item.ts });
    return sendJSON(res, 200, {ok:true, ts:item.ts});
  }
  // —— 管理员接口 ——
  if (req.method === 'POST' && urlPath === '/api/admin/login'){
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    if (String(body.p||'') !== ADMIN_PASS) return sendJSON(res,401,{ok:false,msg:'密码不对'});
    const t = crypto.randomBytes(16).toString('hex');
    adminSessions.add(t);
    return sendJSON(res, 200, {ok:true, token:t});
  }
  if (req.method === 'GET' && urlPath === '/api/admin/accounts'){
    if (!isAdmin(req)) return sendJSON(res, 401, {ok:false,msg:'未授权'});
    const items = [...accounts.entries()].map(([u, a]) => {
      const s = leaderboard.find(x=>x.u===u);
      return { u, best: s ? s.s : 0, email: a.email || '', ip: a.ip || '', strikes: a.strikes || 0 };
    }).sort((a,b)=>a.u.localeCompare(b.u,'zh'));
    return sendJSON(res, 200, {ok:true, items, total:items.length});
  }
  if (req.method === 'POST' && urlPath === '/api/admin/delete'){
    if (!isAdmin(req)) return sendJSON(res, 401, {ok:false,msg:'未授权'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const u = String(body.u||'').trim();
    if (!accounts.has(u)) return sendJSON(res, 404, {ok:false,msg:'账号不存在'});
    banAccount(accounts.get(u));   // 管理员删号也进黑名单
    accounts.delete(u);
    saveUsers();
    cleanupSocial(u);
    leaderboard = leaderboard.filter(x=>x.u!==u);
    saveScores();
    for (const [t, user] of [...tokens.entries()]) if (user===u) tokens.delete(t);
    return sendJSON(res, 200, {ok:true});
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
    if (this.user) removeSocket(this);
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
        addSocket(ws);           // 好友在线状态 / 实时消息靠它找到人
        ws.sendText(JSON.stringify({t:'auth_ok', user}));
        // 刚进大厅：把最近的大厅聊天补发给它，接着再给房间列表
        for (const h of lobbyHistory) ws.sendText(JSON.stringify({t:'chat', from:h.from, text:h.text, history:true}));
        ws.sendText(JSON.stringify({t:'rooms', items:[...rooms.values()].filter(r => !r.isSolo).map(r => ({
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
      ws.sendText(JSON.stringify({t:'rooms', items:[...rooms.values()].filter(r => !r.isSolo).map(r => ({
        id:r.id, name:r.name, owner:r.owner, count:r.count, max:MAX_PLAYERS_PER_ROOM, hasPwd:r.hasPassword()
      }))}));
      return;
    }
    if (msg.t === 'create_room'){
      const name = String(msg.name||'').trim().slice(0, 20);
      if (!name) return ws.sendText(JSON.stringify({t:'sys',msg:'房间名不能为空'}));
      if (hasBannedWord(name)) return ws.sendText(JSON.stringify({t:'sys',msg:'房间名含有不允许的字词'}));
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
    // 单人模式：开一间私密房，塞一个豆包进去陪打
    if (msg.t === 'solo'){
      if (rooms.size >= 50) return ws.sendText(JSON.stringify({t:'sys',msg:'房间数已达上限'}));
      const id = roomId();
      const name = (ws.user + ' 的单人房').slice(0, 20);
      const r = new Room(id, name, ws.user, null);
      r.isSolo = true;
      r.tickMs = 150;
      clearInterval(r.timer);
      r.timer = setInterval(() => r.step(), r.tickMs);
      rooms.set(id, r);
      ws.sendText(JSON.stringify({t:'room_created', id, name, owner:ws.user}));
      r.addPlayer(ws, ws.user);
      r.addBot('豆包');
      broadcastRooms();
      return;
    }
    if (msg.t === 'join_room'){
      const id = String(msg.id||'').trim();
      const r = rooms.get(id);
      if (!r) return ws.sendText(JSON.stringify({t:'sys',msg:'房间不存在'}));
      if (r.isSolo) return ws.sendText(JSON.stringify({t:'sys',msg:'这是别人的单人房'}));
      if (r.hasPassword() && String(msg.pass||'') !== r.pass) return ws.sendText(JSON.stringify({t:'sys',msg:'密码不对'}));
      if (r.count >= MAX_PLAYERS_PER_ROOM) return ws.sendText(JSON.stringify({t:'sys',msg:'房间已满'}));
      r.addPlayer(ws, ws.user);
      broadcastRooms();
      return;
    }
    if (msg.t === 'chat'){
      const text = String(msg.text||'').trim().slice(0, 200);
      if (!text) return;
      if (blockChatIfNeeded(ws, text)) return;
      // 大厅聊天：发给所有已登录但不在房间的用户
      const m = JSON.stringify({t:'chat', from:ws.user, text});
      for (const s of loggedInSockets) if (!s.room) s.sendText(m);
      // 存起来，之后进大厅的人能看到
      lobbyHistory.push({ from:ws.user, text });
      if (lobbyHistory.length > LOBBY_HISTORY_MAX) lobbyHistory.shift();
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
    ws.sendText(JSON.stringify({t:'rooms', items:[...rooms.values()].filter(r => !r.isSolo).map(r => ({
      id:r.id, name:r.name, owner:r.owner, count:r.count, max:MAX_PLAYERS_PER_ROOM, hasPwd:r.hasPassword()
    }))}));
    return;
  }
  if (msg.t === 'chat'){
    const text = String(msg.text||'').trim().slice(0, 200);
    if (!text) return;
    if (blockChatIfNeeded(ws, text)) return;
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
    const r = room.setSpeed(msg.ms, ws.user);
    if (r.ok){
      room.broadcast(JSON.stringify({t:'sys', msg: ws.user+' 把速度调成了 '+room.tickMs+'ms/步'}));
    } else {
      ws.sendText(JSON.stringify({t:'sys', msg: r.msg}));
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
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // 页面/脚本/样式不缓存，避免玩家一直跑旧代码
    if (ext === '.html' || ext === '.js' || ext === '.css') headers['Cache-Control'] = 'no-cache, must-revalidate';
    res.writeHead(200, headers);
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

// 先从云备份恢复账号数据，再开始监听
cloudRestore().finally(() => {
  server.listen(PORT, () => {
    console.log('');
    console.log('  🐍 多人联机贪吃蛇（完整版：账号+房间+排行榜+聊天）');
    console.log('  本机：  http://localhost:'+PORT);
    for (const ip of lanIPs()) console.log('  同 Wi-Fi：http://'+ip+':'+PORT);
    console.log('  Ctrl+C 停止');
    console.log('');
  });
});
