'use strict';
/*
 * 多人联机贪吃蛇 —— 完整版：账号 + 房间 + 排行榜 + 聊天
 * 零 npm 依赖，只用 Node.js 内置模块
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const qagent = require('./bot/qagent'); // 派派 AI（Q 学习账本，见 bot/qtable.json）
const mail = require('./mail'); // 注册验证码邮件

// 派派的账本：第一次用到才读，读不到就只靠安全网走位
let QTABLE = null;
function qtable(){
  if (QTABLE) return QTABLE;
  try {
    QTABLE = qagent.unpack(JSON.parse(fs.readFileSync(path.join(__dirname, 'bot', 'qtable.json'), 'utf8')));
  } catch (e) {
    console.log('[pai] 读不到 bot/qtable.json，先用空账本：', e.message);
    QTABLE = Object.create(null);
  }
  return QTABLE;
}

const PORT = Number(process.env.PORT) || 8180;
const PUBLIC_DIR = path.join(__dirname, 'dist');
// 页面里脚本的 ?v= 由这里自动填：谁最后改过 js/css，版本号就跟谁走，
// 免得「代码已经发上去了，浏览器还在用缓存里的旧文件」。
const ASSET_STAMP = (() => {
  try {
    let newest = 0;
    for (const f of fs.readdirSync(PUBLIC_DIR)) {
      if (!/\.(js|css)$/i.test(f)) continue;
      const m = fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs;
      if (m > newest) newest = m;
    }
    return newest ? String(Math.floor(newest)) : 'v1';
  } catch { return 'v1'; }
})();
let DATA_DIR = path.join(__dirname, 'data');

const COLS = 42, ROWS = 30;
const START_LEN = 3, FOOD_TARGET = 7, FOOD_MAX = 60;
const MAX_PLAYERS_PER_ROOM = 12;
const INPUT_BUFFER = 2;
const COLORS = [
  '#ef4444','#3b82f6','#22c55e','#eab308','#a855f7','#f97316',
  '#06b6d4','#ec4899','#84cc16','#6366f1','#14b8a6','#f43f5e'
];
// —— 皮肤商店目录（服务端是唯一权威，价格/颜色都以这里为准）——
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
function skinById(id){ return SKIN_MAP.get(String(id||'')) || null; }
// 官方账号是展示号：全部皮肤默认解锁，不用签到攒金币
function ownedSkinsOf(u, a){
  const base = new Set((a && Array.isArray(a.owned)) ? a.owned.slice() : []);
  base.add('classic');
  if (isOfficial(u)) SKINS.forEach(s => base.add(s.id));
  return [...base];
}
// 账号身上的皮肤（没买过/没装备就是 classic）
function skinOfUser(u){
  const a = accounts.get(u);
  return skinById(a && a.skin) || SKINS[0];
}
function skinIdOfUser(u){ return skinOfUser(u).id; }
function colorOfUser(u){ return skinOfUser(u).color; }
// 北京时间「今天」，签到按自然日算
function dayKey(d){
  const t = new Date((d ? d.getTime() : Date.now()) + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}
function prevDayKey(key){
  const t = new Date(key + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
// 签到奖励：基础 10，连签 3 天起 +5，连签 7 天起再 +5（封顶 20/天）
function checkinReward(streak){
  if (streak >= 7) return 20;
  if (streak >= 3) return 15;
  return 10;
}

const DIRS = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
const OPPOSITE = { up:'down', down:'up', left:'right', right:'left' };
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 官方账号名：徽章、默认好友、免处罚、自动回复都围绕它
const OFFICIAL_NAME = 'SnakeOnline官方';

// 官方账号登录门禁：密码对了之后，还要往「官方邮箱」发一封 6 位验证码，收得到才算本人
// OFFICIAL_EMAIL 可换收件人；OFFICIAL_ALLOW_IPS 里的本机/局域网地址直接放行
const OFFICIAL_EMAIL = String(process.env.OFFICIAL_EMAIL || 'nqzyy@hotmail.com').trim();
const OFFICIAL_CODE_TTL = 10 * 60 * 1000;   // 验证码 10 分钟有效
const OFFICIAL_ALLOW_IPS = String(process.env.OFFICIAL_ALLOW_IPS || '127.0.0.1,::1,192.168.1.21')
  .split(',').map(s => s.trim()).filter(Boolean);

function officialAllowed(req){
  if (!req) return false;
  const ip = String(clientIp(req) || '').replace(/^::ffff:/, '');
  return OFFICIAL_ALLOW_IPS.includes(ip);
}

function randInt(n){ return (Math.random()*n)|0; }

// ============================================================
//  AUTH（账号/排行榜持久化）
// ============================================================
// 有些托管环境的代码目录是只读的，建不了也写不了 data/，就退到系统临时目录
function pickDataDir(){
  const candidates = [process.env.SNAKE_DATA_DIR, path.join(__dirname, 'data'), path.join(os.tmpdir(), 'snake-online-data')].filter(Boolean);
  for (const dir of candidates){
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.writable'), 'ok');
      return dir;
    } catch {}
  }
  return path.join(os.tmpdir(), 'snake-online-data');
}
DATA_DIR = pickDataDir();

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');

// 内存缓存：Map<username, { hash, salt }>、Map<username, best>
let accounts = new Map();
let leaderboard = []; // [{u, s}]

function loadUsers(){
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_FILE,'utf8'));
    accounts = new Map(raw.map(a => [a.u, { hash:a.h, salt:a.s, strikes:a.n||0, muteUntil:a.m||0, email:a.e||'', ip:a.i||'', coins:a.c||0, lastCheckin:a.l||'', streak:a.st||0, owned:Array.isArray(a.o)?a.o.slice():[], skin:a.k||'classic' }]));
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

// 空库自举：本地没有任何账号时，从私有数据仓库拉 users/friends/scores
// 需要环境变量 SNAKE_SEED_REPO（如 s2ys9jgn4d-star/snake-online-data）+ GH_TOKEN
const SEED_REPO = process.env.SNAKE_SEED_REPO || '';

async function seedFromRepo(){
  if (!SEED_REPO || !GH_TOKEN) return;
  if (accounts.size > 0) return;
  try {
    const files = [
      ['users.json', USERS_FILE, loadUsers],
      ['scores.json', SCORES_FILE, loadScores],
      ['friends.json', FRIENDS_FILE, loadSocial]
    ];
    let got = 0;
    for (const [name, dest, reload] of files){
      const res = await fetch(`https://api.github.com/repos/${SEED_REPO}/contents/${name}`, { headers: ghHeaders() });
      if (!res.ok){ console.log('自举：' + name + ' 拉取失败 HTTP ' + res.status); continue; }
      const j = await res.json();
      fs.writeFileSync(dest, Buffer.from(j.content, 'base64').toString('utf8'));
      reload();
      got++;
    }
    if (got) console.log('空库自举完成：' + accounts.size + ' 个账号，' + leaderboard.length + ' 条分数（来源 ' + SEED_REPO + '）');
  } catch (e) { console.log('空库自举出错：' + e.message); }
}

// 把三份数据原样推回私有仓库（没有 BACKUP_KEY 时的持久化兜底）
async function pushSeedPlain(){
  if (!SEED_REPO || !GH_TOKEN) return;
  const files = [['users.json', USERS_FILE], ['scores.json', SCORES_FILE], ['friends.json', FRIENDS_FILE]];
  for (const [name, src] of files){
    try {
      if (!fs.existsSync(src)) continue;
      const api = `https://api.github.com/repos/${SEED_REPO}/contents/${name}`;
      const cur = await fetch(api, { headers: ghHeaders() });
      let sha = cur.ok ? (await cur.json()).sha : null;
      const body = { message: 'sync ' + name + ' ' + new Date().toISOString(), content: Buffer.from(fs.readFileSync(src, 'utf8')).toString('base64') };
      if (sha) body.sha = sha;
      const put = await fetch(api, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
      if (!put.ok) console.log('数据同步失败 ' + name + '：HTTP ' + put.status);
    } catch (e) { console.log('数据同步出错 ' + name + '：' + e.message); }
  }
}

// 每次保存后 5 秒防抖：有 BACKUP_KEY 走加密备份，否则推私有仓库
let backupTimer = null;
function cloudBackup(){
  if (!GH_TOKEN) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    if (!BACKUP_KEY){ await pushSeedPlain(); return; }
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

function saveUsers(){ atomicWrite(USERS_FILE, [...accounts.entries()].map(([u,a])=>({u, h:a.hash, s:a.salt, n:a.strikes||0, m:a.muteUntil||0, e:a.email||'', i:a.ip||'', c:a.coins||0, l:a.lastCheckin||'', st:a.streak||0, o:a.owned||[], k:a.skin||'classic'}))); cloudBackup(); }
function saveScores(){ atomicWrite(SCORES_FILE, leaderboard); cloudBackup(); }

// ============================================================
//  注册验证码（只存在内存里，10 分钟过期，服务器重启就失效）
// ============================================================
const emailCodes = new Map();     // email -> { code, exp }
const resetCodes = new Map();     // username -> { code, exp, tries } —— 重置密码用
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
// 能不能真的发信（官方验证码不看 REQUIRE_EMAIL_CODE，永远要发）
function mailSendable(){ return !!(mail.apiConfig() || mail.isConfigured()); }

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

// —— 消息 id 与撤回 ——
// 私聊、群聊的每条消息都带一个短 id，撤回时靠它对上号；老数据没有 id，读的时候补上
const RECALL_TTL = 5 * 60 * 1000;   // 发出去 5 分钟内可以撤回
let msgSeq = 0;
function nextMid(){ msgSeq = (msgSeq + 1) % 1e7; return Date.now().toString(36) + '-' + msgSeq.toString(36); }
function ensureMsgIds(list){
  let changed = false;
  for (const m of list || []) if (m && !m.id){ m.id = nextMid(); changed = true; }
  return changed;
}

// 好友列表：官方账号与所有人默认互为好友（不用申请）
function friendListOf(u){
  const list = social.friends[u] || [];
  if (u !== OFFICIAL_NAME && accounts.has(OFFICIAL_NAME) && !list.includes(OFFICIAL_NAME))
    return [...list, OFFICIAL_NAME];
  return list;
}
function areFriends(a, b){ return friendListOf(a).includes(b); }
function addFriendPair(a, b){
  social.friends[a] = social.friends[a] || [];
  social.friends[b] = social.friends[b] || [];
  if (!social.friends[a].includes(b)) social.friends[a].push(b);
  if (!social.friends[b].includes(a)) social.friends[b].push(a);
}
// 私聊官方时的自动回复（同一个人 10 分钟内最多回一次，避免刷屏）
const OFFICIAL_AUTO_REPLY = '你好，我是本游戏的官方，发现什么 Bug 请联系邮箱：nqzyy@hotmail.com，谢谢您对联机贪吃蛇的支持！';
const OFFICIAL_REPLY_GAP = 10 * 60 * 1000;
const officialReplyAt = new Map();   // 发送者 -> 上次自动回复时间
function maybeOfficialReply(from){
  if (from === OFFICIAL_NAME) return;
  if (Date.now() - (officialReplyAt.get(from) || 0) < OFFICIAL_REPLY_GAP) return;
  officialReplyAt.set(from, Date.now());
  const k = pairKey(from, OFFICIAL_NAME);
  const arr = social.msgs[k] = social.msgs[k] || [];
  // 欢迎语在打开聊天时就已经放进去了，这里再回一次就是重复的同一条
  if (arr.some(m => m.from === OFFICIAL_NAME && m.text === OFFICIAL_AUTO_REPLY)) return;
  const item = { id: nextMid(), from: OFFICIAL_NAME, text: OFFICIAL_AUTO_REPLY, ts: Date.now() };
  arr.push(item);
  if (arr.length > 100) arr.splice(0, arr.length - 100);
  saveSocial();
  pushToUser(from, { t:'friend_msg', id: item.id, from: OFFICIAL_NAME, text: OFFICIAL_AUTO_REPLY, ts: item.ts });
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
//  群组：每人最多建 5 个群，加入要申请，群主可踢人/解散
// ============================================================
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
let groups = {};
function loadGroups(){
  try { groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')) || {}; } catch { groups = {}; }
}
loadGroups();
function saveGroups(){ atomicWrite(GROUPS_FILE, groups); }
const GROUP_MAX_OWNED = 5;
const GROUP_MSG_KEEP = 200;
function groupsOwnedBy(u){ return Object.values(groups).filter(g => g.owner === u); }
function isGroupMember(g, u){ return !!g && (g.members || []).includes(u); }
function groupBrief(g, u){
  return { id: g.id, name: g.name, owner: g.owner, count: (g.members || []).length,
           isOwner: g.owner === u, reqs: g.owner === u ? (g.reqs || []).length : 0 };
}
function newGroupId(){
  let id;
  do { id = 'g' + Math.random().toString(36).slice(2, 8); } while (groups[id]);
  return id;
}
function pushGroupMembers(g, msg, except){
  for (const m of g.members || []) if (m !== except) pushToUser(m, msg);
}
// 账号注销时把群里的痕迹清理干净：退群、撤回申请，群主注销则解散
function cleanupGroups(u){
  for (const id of Object.keys(groups)){
    const g = groups[id];
    if (g.owner === u){
      delete groups[id];
      pushGroupMembers(g, { t:'group_delete', id, name: g.name });
      continue;
    }
    const before = (g.members || []).length;
    g.members = (g.members || []).filter(x => x !== u);
    g.reqs = (g.reqs || []).filter(r => r.from !== u);
    if (g.members.length !== before) pushGroupMembers(g, { t:'group_member', id, name: g.name, from: u });
  }
  saveGroups();
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

// —— hCaptcha ——
// 两个变量都填了才启用；只填 Site Key 时前端会显示组件但服务端不拦，避免误配置锁死登录
const HCAPTCHA_SITE_KEY = process.env.HCAPTCHA_SITE_KEY || '';
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET || '';

function postFormOnce(urlStr, fields, extraHeaders){
  return new Promise(resolve => {
    let u;
    try { u = new URL(urlStr); } catch (_) { return resolve(null); }
    const data = new URLSearchParams(fields).toString();
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        ...(extraHeaders || {})
      },
      timeout: 8000
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

async function verifyCaptcha(token, ip){
  if (!HCAPTCHA_SECRET) return true;        // 没配置就跳过
  // 没带票据：说明前端没渲染出验证码（网络被墙、旧客户端、脚本加载失败）。
  // 这里放行，否则所有人会被锁在门外；带了票据的一律严格校验。
  if (!token) return true;
  const r = await postFormOnce('https://api.hcaptcha.com/siteverify', {
    secret: HCAPTCHA_SECRET,
    response: String(token),
    remoteip: ip || '',
    sitekey: HCAPTCHA_SITE_KEY
  });
  return !!(r && r.success === true);
}

// ============================================================
//  第三方快捷登录：Microsoft / Google / GitHub
//  配了 CLIENT_ID + CLIENT_SECRET 才启用，没配的按钮前端不显示
//  Apple 不做：邮箱是私密转发地址（@privaterelay.appleid.com），
//  而且 client_secret 要现签 ES256 JWT，收益很低
// ============================================================
const OAUTH_BASE = (process.env.PUBLIC_BASE_URL || 'https://snake-online.up.railway.app').replace(/\/+$/, '');
const OAUTH_RETURN_HOSTS = new Set([
  'snake-online.up.railway.app',
  '37jufc1enq2k6cj3uvh.traesite.cn',
  'localhost',
  '127.0.0.1'
]);
const OAUTH_PROVIDERS = {
  microsoft: {
    id: process.env.MICROSOFT_CLIENT_ID || '',
    secret: process.env.MICROSOFT_CLIENT_SECRET || '',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email profile User.Read'
  },
  google: {
    id: process.env.GOOGLE_CLIENT_ID || '',
    secret: process.env.GOOGLE_CLIENT_SECRET || '',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile'
  },
  github: {
    id: process.env.GITHUB_CLIENT_ID || '',
    secret: process.env.GITHUB_CLIENT_SECRET || '',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email'
  }
};
function oauthReady(p){ const c = OAUTH_PROVIDERS[p]; return !!(c && c.id && c.secret); }
const oauthStates = new Map();   // state -> {p, ret, exp}，防止伪造回调
const oauthTickets = new Map();  // 一次性票据 -> 登录用户，避免 token 出现在地址栏

function getJsonOnce(urlStr, headers){
  return new Promise(resolve => {
    let u;
    try { u = new URL(urlStr); } catch (_) { return resolve(null); }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: { 'Accept':'application/json', 'User-Agent':'snake-online', ...(headers || {}) },
      timeout: 8000
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// 各平台拿「已验证的邮箱」：三家接口长得都不一样
async function oauthProfile(p, token){
  if (p === 'google'){
    const j = await getJsonOnce('https://www.googleapis.com/oauth2/v3/userinfo', { Authorization: 'Bearer ' + token }) || {};
    if (!j.email || j.email_verified === false) return null;
    return { email: normalizeEmail(j.email), name: j.name || '' };
  }
  if (p === 'microsoft'){
    const j = await getJsonOnce('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', { Authorization: 'Bearer ' + token }) || {};
    const email = j.mail || j.userPrincipalName || '';
    if (!EMAIL_RE.test(email)) return null;
    return { email: normalizeEmail(email), name: j.displayName || '' };
  }
  if (p === 'github'){
    const j = await getJsonOnce('https://api.github.com/user', { Authorization: 'Bearer ' + token, 'Accept': 'application/vnd.github+json' }) || {};
    const list = await getJsonOnce('https://api.github.com/user/emails', { Authorization: 'Bearer ' + token, 'Accept': 'application/vnd.github+json' });
    const arr = Array.isArray(list) ? list : [];
    const pick = arr.find(e => e.primary && e.verified) || arr.find(e => e.verified);
    const email = pick ? pick.email : '';
    if (!EMAIL_RE.test(email)) return null;
    return { email: normalizeEmail(email), name: j.name || j.login || '' };
  }
  return null;
}

function accountByEmail(email){
  if (!email) return '';
  for (const [u, a] of accounts) if (a.email === email) return u;
  return '';
}
// 用邮箱前缀当昵称，重名就加数字，实在不行随机
function usernameFromEmail(email, name){
  let base = String(name || email.split('@')[0] || '').replace(/[^0-9A-Za-z_\u4e00-\u9fa5]/g, '');
  if (base.length < 2) base = email.split('@')[0].replace(/[^0-9A-Za-z_]/g, '');
  if (base.length < 2) base = 'player';
  base = base.slice(0, 14);
  for (let i = 1; i <= 999; i++){
    const cand = i === 1 ? base : base + i;
    if (!accounts.has(cand) && !guests.has(cand) && cand !== OFFICIAL_NAME && !hasBannedWord(cand)) return cand;
  }
  return 'player' + crypto.randomBytes(3).toString('hex');
}

function oauthRedirect(res, location){
  res.writeHead(302, { 'Location': location, 'Cache-Control': 'no-store' });
  res.end();
}
function oauthBack(res, ret, reason){
  return oauthRedirect(res, ret + (ret.includes('?') ? '&' : '?') + 'oauth=' + reason);
}

async function handleOauth(req, res, urlPath){
  // 前端用一次性票据换登录态（避免 token 出现在地址栏/历史记录里）
  if (urlPath === '/api/oauth/exchange' && req.method === 'POST'){
    const body = await readBody(req);
    const code = String(body.code || '');
    const t = oauthTickets.get(code);
    if (!t || t.exp < Date.now()){
      return sendJSON(res, 400, { ok:false, msg:'登录已过期，请重试', key:'oauthFail' });
    }
    oauthTickets.delete(code);
    const token = newToken(t.user, req);

    if (!token) return sendJSON(res, 403, { ok:false, msg:'官方账号只能在授权设备上登录', key:'officialGuard' });
    return sendJSON(res, 200, { ok:true, token, user:t.user, muteLeft: muteLeftOf(t.user) }, { 'Set-Cookie': authCookie(token) });
  }

  const m = urlPath.match(/^\/api\/oauth\/([a-z]+)\/(start|callback)$/);
  if (!m || req.method !== 'GET'){ res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }); return res.end('404'); }
  const p = m[1], kind = m[2];
  if (!oauthReady(p)){
    res.writeHead(400, { 'Content-Type':'text/html; charset=utf-8' });
    return res.end('<meta charset="utf-8"><p style="font:16px sans-serif;padding:24px">这个登录方式还没配置，请联系管理员。</p>');
  }
  const conf = OAUTH_PROVIDERS[p];
  const redirectUri = OAUTH_BASE + '/api/oauth/' + p + '/callback';

  if (kind === 'start'){
    let ret = String(new URL(req.url, 'http://x').searchParams.get('return') || '');
    try {
      const ru = new URL(ret);
      if (!/^https?:$/.test(ru.protocol) || !OAUTH_RETURN_HOSTS.has(ru.hostname)) ret = '';
    } catch (_) { ret = ''; }
    if (!ret) ret = OAUTH_BASE + '/mobile.html';

    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, { p, ret, exp: Date.now() + 5 * 60 * 1000 });
    if (oauthStates.size > 500){ for (const [k, v] of oauthStates) if (v.exp < Date.now()) oauthStates.delete(k); }

    const params = new URLSearchParams({
      client_id: conf.id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: conf.scope,
      state
    });
    if (p === 'google') params.set('prompt', 'select_account');
    if (p === 'microsoft') params.set('response_mode', 'query');
    return oauthRedirect(res, conf.authUrl + '?' + params.toString());
  }

  // 回调：先验 state，再换 token，再拿邮箱
  const state = String(new URL(req.url, 'http://x').searchParams.get('state') || '');
  const ent = oauthStates.get(state);
  oauthStates.delete(state);
  if (!ent || ent.exp < Date.now() || ent.p !== p) return oauthRedirect(res, OAUTH_BASE + '/mobile.html?oauth=state');
  const ret = ent.ret;
  const q = new URL(req.url, 'http://x').searchParams;
  if (q.get('error')) return oauthBack(res, ret, 'denied');
  const code = String(q.get('code') || '');
  if (!code) return oauthBack(res, ret, 'nocode');

  const tr = await postFormOnce(conf.tokenUrl, {
    client_id: conf.id,
    client_secret: conf.secret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  }, p === 'github' ? { 'Accept': 'application/json' } : null);
  const at = tr && tr.access_token;
  if (!at) return oauthBack(res, ret, 'token');

  const prof = await oauthProfile(p, at);
  if (!prof) return oauthBack(res, ret, 'email');

  const ip = clientIp(req);
  const banMsg = bannedHit(prof.email, ip);
  if (banMsg) return oauthBack(res, ret, 'banned');

  let user = accountByEmail(prof.email);
  if (!user){
    user = usernameFromEmail(prof.email, prof.name);
    const { hash, salt } = hashPass(crypto.randomBytes(12).toString('hex'));
    accounts.set(user, { hash, salt, email: prof.email, ip, oauth: p });
    saveUsers();
  }

  const ticket = crypto.randomBytes(18).toString('hex');
  oauthTickets.set(ticket, { user, exp: Date.now() + 60 * 1000 });
  if (oauthTickets.size > 500){ for (const [k, v] of oauthTickets) if (v.exp < Date.now()) oauthTickets.delete(k); }
  return oauthRedirect(res, ret + (ret.includes('?') ? '&' : '?') + 'oauthCode=' + ticket);
}

// ============================================================
//  手机号验证码登录：Twilio（国际）/ 阿里云短信（国内）
//  两家都没配时不显示手机号入口，也不影响原有登录
// ============================================================
function smsProvider(){
  if (process.env.ALIYUN_SMS_KEY_ID && process.env.ALIYUN_SMS_KEY_SECRET &&
      process.env.ALIYUN_SMS_SIGN && process.env.ALIYUN_SMS_TEMPLATE) return 'aliyun';
  if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM) return 'twilio';
  return '';
}
// 11 位国内号码补 +86，统一存 E.164
function normPhone(raw){
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (/^1\d{10}$/.test(s)) s = '+86' + s;
  if (!/^\+\d{8,15}$/.test(s)) return '';
  return s;
}
function percentEncode(s){
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
async function aliyunSms(phone, code){
  const p = {
    AccessKeyId: process.env.ALIYUN_SMS_KEY_ID,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone.replace(/^\+/, ''),
    RegionId: 'cn-hangzhou',
    SignName: process.env.ALIYUN_SMS_SIGN,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomBytes(8).toString('hex'),
    SignatureVersion: '1.0',
    TemplateCode: process.env.ALIYUN_SMS_TEMPLATE,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25'
  };
  const canon = Object.keys(p).sort().map(k => percentEncode(k) + '=' + percentEncode(p[k])).join('&');
  const s2s = 'GET&' + percentEncode('/') + '&' + percentEncode(canon);
  const sig = crypto.createHmac('sha1', process.env.ALIYUN_SMS_KEY_SECRET + '&').update(s2s).digest('base64');
  const j = await getJsonOnce('https://dysmsapi.aliyuncs.com/?Signature=' + percentEncode(sig) + '&' + canon);
  return !!(j && j.Code === 'OK');
}
async function twilioSms(phone, code){
  const sid = process.env.TWILIO_SID;
  const r = await postFormOnce('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
    To: phone,
    From: process.env.TWILIO_FROM,
    Body: '【联机贪吃蛇】验证码 ' + code + '，10 分钟内有效。'
  }, {
    Authorization: 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_TOKEN).toString('base64'),
    Accept: 'application/json'
  });
  // 注意：失败时 Twilio 也返回 status:401，必须用 sid 判断成功
  return !!(r && r.sid && !r.code);
}
function sendSmsCode(phone, code){
  return smsProvider() === 'aliyun' ? aliyunSms(phone, code) : twilioSms(phone, code);
}
const smsCodes = new Map();     // 手机号 -> {code, exp}
const smsCooldown = new Map();  // 手机号 -> 上次发送时间
// 全局限流：每个 IP 每分钟最多 240 次 API 请求，防脚本刷接口烧资源
const apiHits = new Map();      // IP -> {n, t}
const API_HIT_LIMIT = Number(process.env.API_HIT_LIMIT) || 240;
const smsIpHits = new Map();    // IP -> {n, t}，防止被刷

function accountByPhone(phone){
  if (!phone) return '';
  for (const [u, a] of accounts) if (a.phone === phone) return u;
  return '';
}
function usernameFromPhone(phone){
  const base = '玩家' + phone.slice(-4);
  let cand = base;
  for (let i = 2; i <= 999; i++){
    if (!accounts.has(cand) && !guests.has(cand) && !hasBannedWord(cand)) return cand;
    cand = base + i;
  }
  return '玩家' + crypto.randomBytes(3).toString('hex');
}

// 我和某人的关系：friend 好友 / outgoing 我已申请 / incoming 他申请了我 / '' 陌生人
function relationOf(me, other){
  if (areFriends(me, other)) return 'friend';
  if ((social.reqs[me] || []).some(r => r.from === other)) return 'incoming';
  if ((social.reqs[other] || []).some(r => r.from === me)) return 'outgoing';
  return '';
}
function bestOf(u){ const s = leaderboard.find(x => x.u === u); return s ? s.s : 0; }

// 官方账号不上榜：它只用来发公告、当管理员，成绩不参与排行
const OFFICIAL_BEST = 0;
function ensureOfficialScore(){
  const before = leaderboard.length;
  leaderboard = leaderboard.filter(x => x.u !== OFFICIAL_NAME);
  if (leaderboard.length !== before) saveScores();
}

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
// 官方账号两步登录用的一次性票据：密码通过后先给票据，密钥对了才换令牌
const officialTickets = new Map();
// 游客：只存在内存里，重启就没了（不写 users.json，不进排行榜，不改好友数据）
const guests = new Set();
function isGuest(u){ return guests.has(u); }
function newGuestName(){
  for (let i = 0; i < 50; i++){
    const n = '游客' + crypto.randomInt(1000, 10000);
    if (!accounts.has(n) && !guests.has(n) && n !== OFFICIAL_NAME) return n;
  }
  return '游客' + Date.now().toString().slice(-6);
}
function newToken(user, req, force){
  // 官方账号不给门禁外的请求发令牌；force 只给「管理员密钥已校验通过」的路径用
  if (user === OFFICIAL_NAME && !force && !officialAllowed(req)) return null;
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, user);
  return t;
}

function updateScore(user, score){
  if (!user || !score) return;
  if (isGuest(user)) return;   // 游客的成绩不进排行榜
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
  findSpawn(minLen){
    const need = Math.max(START_LEN, minLen || 0) + 2;
    for (let i=0;i<300;i++){
      const x=6+randInt(COLS-12), y=2+randInt(ROWS-4);
      let ok=true;
      for (let k=0;k<need;k++) if (x-k<0 || this.cellOccupied(x-k,y)) { ok=false; break; }
      if (ok) return {x,y};
    }
    return {x:6, y:randInt(ROWS-4)+2};
  }
  resetPlayer(p){
    const c = this.findSpawn(p.startLen);
    p.body = [];
    // 高难度机器人出场就更长，身子本身就是一道墙（真人永远是 START_LEN）
    const len = p.startLen || START_LEN;
    for (let i=0;i<len;i++) p.body.push({x:c.x-i, y:c.y});
    p.dir='right'; p.queue=[]; p.alive=true; p.score=0; p.deathReason='';
  }

  // —— 主循环（和旧版 step 完全一致，只是移到实例方法） ——
  step(){
    this.tick++;
    // 派派 AI：单人模式的电脑对手
    for (const p of this.players.values()){
      if (!p.isBot) continue;
      if (!p.alive){
        // 撞死了就等 2 秒复活，否则单人房会变成空房
        const now = Date.now();
        if (!p.botRespawnAt) p.botRespawnAt = now + 2000;
        else if (now >= p.botRespawnAt){
          p.botRespawnAt = 0;
          this.resetPlayer(p);
          this.broadcast(JSON.stringify({t:'chat', from:'系统', text:(p.name || '派派') + ' 复活了'}));
        }
        continue;
      }
      const d = qagent.decide(this, p, COLS, ROWS, qtable(), qagent.profileOf(p.botDiff));
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
      if (h.x<0||h.y<0||h.x>=COLS||h.y>=ROWS) dead.set(p.id,'deadWall');
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
      if (owner !== undefined) dead.set(p.id, owner===p.id ? 'deadSelf' : 'deadOther');
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
    if (!Number.isFinite(v)) return { ok:false, msg:'速度值无效', key:'speedInvalid' };
    if (by !== this.owner) return { ok:false, msg:'只有房主能调速度，你可以自己开一个房间', key:'speedOwner' };
    const now = Date.now();
    if (now - (this.lastSpeedAt || 0) < 5000) return { ok:false, msg:'调得太频繁了，等几秒再试', key:'speedTooFast' };
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
        id: p.id, name: p.name, color: p.color, skin: p.skin || 'classic', score: p.score,
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
      ws.sendText(JSON.stringify({t:'sys',msg:'房间已满（最多'+MAX_PLAYERS_PER_ROOM+'人）', key:'roomFullMax', args:{n:MAX_PLAYERS_PER_ROOM}}));
      ws.sendText(JSON.stringify({t:'room_full'}));
      return null;
    }
    const id = this.nextPlayerId++;
    const p = {
      id, ws, name: username, color: colorOfUser(username) || COLORS[(id-1)%COLORS.length], skin: skinIdOfUser(username),
      body:[], queue:[], dir:'right', alive:false, score:0, deathReason:'', newHead:null
    };
    this.resetPlayer(p);
    this.players.set(id, p);
    ws.playerId = id; ws.room = this;
    ws.sendText(JSON.stringify({t:'joined_room', roomId:this.id, roomName:this.name, solo:this.isSolo, soloOf:this.owner, id, cols:COLS, rows:ROWS, tickMs:this.tickMs}));
    ws.sendText(this.snapshot());
    this.broadcast(JSON.stringify({t:'chat', from:'系统', sys:1, key:'sysJoined', args:{name:username}, text:username+' 加入了房间'}));
    return p;
  }
  // 单人模式的电脑对手：没有真 socket，用一个空壳占位
  addBot(username, kind, diff){
    const id = this.nextPlayerId++;
    const stub = { sendText(){}, ping(){}, close(){}, lastSeen: Infinity, playerId: id, room: this };
    const p = {
      id, ws: stub, name: username, color: COLORS[(id-1)%COLORS.length], skin: 'classic',
      body:[], queue:[], dir:'right', alive:false, score:0, deathReason:'', newHead:null,
      isBot: true, botKind: kind || 'pai', botDiff: diff || 'normal',
      // 难度越高出场越长：长身子才有“堵人”的本钱
      startLen: ({ easy: 3, normal: 3, hard: 5, nightmare: 8 })[diff] || START_LEN
    };
    this.resetPlayer(p);
    this.players.set(id, p);
    this.broadcast(JSON.stringify({t:'chat', from:'系统', sys:1, key:'sysJoined', args:{name:username}, text:username+' 加入了房间'}));
    return p;
  }

  removePlayer(player){
    this.players.delete(player.id);
    this.broadcast(JSON.stringify({t:'chat', from:'系统', sys:1, key:'sysLeft', args:{name:player.name}, text:player.name+' 离开了房间'}));
    this.broadcastState();
    // 单人房：真人走了就整间销毁，别留一个空房间给机器人自己玩
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
// 按请求头 UA 判断设备，下载页用服务端的结果（跟 KukeChat 一样的思路）
function detectPlatform(ua){
  ua = String(ua || '');
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows NT|Win64|WOW64|WindowsPhone/i.test(ua)) return 'win';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/CrOS/i.test(ua)) return 'linux';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return '';
}

function sendJSON(res, code, obj, extraHeaders){
  const body = JSON.stringify(obj);
  // 登录态放在 httpOnly Cookie 里，前端挂了 withCredentials，所以不能用 *
  const origin = (res.req && res.req.headers && res.req.headers.origin) || '';
  res.writeHead(code, {
    'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
    ...(extraHeaders || {})
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
// —— 登录态 Cookie ——
// httpOnly 让页面脚本读不到，XSS 也偷不走；SameSite=None + Secure 是为了让
// file:// 打开的离线客户端请求线上接口时也能带上（否则跨站请求会被丢弃）。
const AUTH_COOKIE = 'snakeToken';
const AUTH_COOKIE_AGE = 60 * 60 * 24 * 30;
function parseCookies(req){
  const raw = (req && req.headers && req.headers.cookie) || '';
  const out = {};
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function authCookie(token){
  return AUTH_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=' + AUTH_COOKIE_AGE;
}
const AUTH_COOKIE_CLEAR = AUTH_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0';

function authFromReq(req){
  // 优先 Cookie；旧客户端没有 Cookie，继续认 Authorization
  const h = (req.headers.authorization||'').trim();
  if (h.startsWith('Bearer ')){
    const u = tokens.get(h.slice(7));
    if (u) return u;
  }
  const c = parseCookies(req)[AUTH_COOKIE];
  return c ? (tokens.get(c) || null) : null;
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

// 官方账号：界面上显示「官方」徽章，且不受违禁词处罚（防止测试时把自己封掉）
const OFFICIAL_USERS = new Set(['SnakeOnline官方']);
function isOfficial(u){ return OFFICIAL_USERS.has(u); }

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
  if (isOfficial(user)) return '官方账号不受违禁词处罚（这条消息被拦下，不记过）';
  const a = accounts.get(user);
  if (!a) return null;
  a.strikes = (a.strikes || 0) + 1;

  if (a.strikes >= 3){
    banAccount(a);           // 拉黑邮箱和注册 IP，防止换个用户名再来
    accounts.delete(user);
    saveUsers();
    cleanupSocial(user);
    cleanupGroups(user);
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
    ws.sendText(JSON.stringify({t:'sys', msg:'你正在禁言中，还需等待 ' + fmtLeft(left), key:'mutedFor', args:{t:fmtLeft(left)}}));
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
//  测试账号清理（一次性）：只删邮箱为空或 @test/@example 的，真用户不受影响，也不拉黑
const CLEANUP_NAMES = ["小明", "t1", "手机测试", "手机", "违禁词测试", "豆包", "豆包1", "豆包2", "豆包3", "路人甲", "单人测试36264", "单人测试61304", "单人测试8542", "单人测试53988", "单人测试29490", "单人测试99830", "诊断37456", "观察60702", "抓帧4882", "观察83067", "单人测试41389", "观察85777", "solo96638", "solo12896", "solo74108", "solo35180", "solo60861", "solo31785", "小测A726", "小测B890", "小测A445", "小测B672", "观察员", "界面测试1", "免验证码用户", "兜底甲", "无邮箱小伙", "验证码小伙", "图码小伙", "界面图码833", "界面图码X3", "普通66384", "甲281208", "乙281208", "小测215449", "复测232251", "tester43733", "tester73473", "host26921", "rt837475", "ag523972"];
function applyCleanupList(){
  let removed = 0;
  for (const name of CLEANUP_NAMES){
    const a = accounts.get(name);
    if (!a) continue;
    if (a.email && !/@(test|example)\.com$/i.test(a.email)) continue;
    accounts.delete(name);
    cleanupSocial(name);
    cleanupGroups(name);
    leaderboard = leaderboard.filter(x => x.u !== name);
    for (const [t, user] of [...tokens.entries()]) if (user === name) tokens.delete(t);
    removed++;
  }
  if (removed){ saveUsers(); saveScores(); console.log('  🧹 清掉测试账号 ' + removed + ' 个（没有进黑名单）'); }
}

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
    // 前端是带 Cookie 请求的（credentials:'include'），这时浏览器要求
    // 预检的 Allow-Origin 必须回显具体来源，不能是 *，否则整条请求被判跨域失败
    // （页面显示「网络错误」）。file:// 打开的客户端 Origin 是字符串 "null"，也要回显。
    const origin = String(req.headers.origin || '');
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin'
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
        code,
        purpose: '注册',
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
    // 注册必须先勾选同意服务条款与隐私政策。
    // 已发布的老客户端请求里没有这个字段，所以只拦截显式拒绝（false），避免它们无法注册。
    if (body.agree === false) return sendJSON(res, 400, {ok:false,msg:'请先阅读并同意服务条款和隐私政策', key:'errAgree'});
    // 注册也要过人机验证（配置了 hCaptcha 才拦）
    if (!(await verifyCaptcha(body.hcaptcha, clientIp(req))))
      return sendJSON(res, 400, {ok:false,msg:'人机验证没通过，请重新验证', key:'errHcaptcha'});
    const u = String(body.u||'').trim();
    const p = String(body.p||'');
    const email = normalizeEmail(body.email);
    const code = String(body.code||'').trim();
    if (!u || u.length>16 || /[^\w\u4e00-\u9fa5]/.test(u)) return sendJSON(res,400,{ok:false,msg:'用户名 1-16 字，只允许字母/数字/中文', key:'errUserFormat'});
    if (p.length<4 || p.length>32) return sendJSON(res,400,{ok:false,msg:'密码 4-32 位', key:'errPassLen'});
    // 邮箱必填：即使发不了验证码也要填，用来追溯封号
    const needEmail = mailUsable();
    if (!EMAIL_RE.test(email)) return sendJSON(res,400,{ok:false,msg:'邮箱格式不对，要像 abc@example.com 这样', key:'errEmailFormat'});
    if (hasBannedWord(u)) return sendJSON(res,400,{ok:false,msg:'用户名含有不允许的字词，换一个吧', key:'errBannedWord'});
    if (accounts.has(u)) return sendJSON(res,409,{ok:false,msg:'用户名已存在', key:'errUserExists'});
    if (guests.has(u)) return sendJSON(res,409,{ok:false,msg:'这个名字正被游客使用，换一个吧', key:'errGuestName'});
    for (const a of accounts.values()) if (a.email === email) return sendJSON(res,409,{ok:false,msg:'这个邮箱已经注册过账号了', key:'errEmailUsed'});
    const ip = clientIp(req);
    const hit = bannedHit(email, ip);
    if (hit) return sendJSON(res, 403, {ok:false, msg:hit, key:'bannedMsg'});
    if (needEmail){
      const rec = emailCodes.get(email);
      if (!rec || rec.exp < Date.now() || rec.code !== code) return sendJSON(res,400,{ok:false,msg:'验证码不对或已过期，重新发一次', key:'errCodeWrong'});
      emailCodes.delete(email);
    } else {
      // 没开邮箱验证时，用图片验证码兜底，防止机器人乱注册
      if (!checkCaptcha(String(body.cid||''), body.captcha)) return sendJSON(res,400,{ok:false,msg:'验证码不对，点「换一张」再试', key:'errBadCaptcha'});
    }
    const { hash, salt } = hashPass(p);
    accounts.set(u, { hash, salt, email, ip });
    saveUsers();
    // 直接发 token，注册后不用再登一次（hCaptcha 票据是一次性的）
    const token = newToken(u, req);
    if (!token) return sendJSON(res, 403, { ok:false, msg:'官方账号只能在授权设备上登录', key:'officialGuard' });
    return sendJSON(res, 200, {ok:true, token, user:u, muteLeft:0}, {'Set-Cookie': authCookie(token)});
  }
  if (req.method === 'POST' && urlPath === '/api/login'){
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    if (!(await verifyCaptcha(body.hcaptcha, clientIp(req))))
      return sendJSON(res, 400, {ok:false,msg:'人机验证没通过，请重新验证', key:'errHcaptcha'});
    const u = String(body.u||'').trim();
    const p = String(body.p||'');
    const a = accounts.get(u);
    if (!a || !verifyPass(p, a.salt, a.hash)) return sendJSON(res,401,{ok:false,msg:'用户名或密码不对', key:'errUserPass'});
    // 官方账号：密码对了也先不发令牌，先往官方邮箱发一封验证码，前端弹窗让人填
    if (u === OFFICIAL_NAME && !officialAllowed(req)){
      if (!mailSendable())
        return sendJSON(res, 503, { ok:false, msg:'邮箱服务暂时不可用，官方账号这会儿登不了', key:'officialNoMail' });
      const ticket = crypto.randomBytes(16).toString('hex');
      const code = String(crypto.randomInt(100000, 1000000));
      officialTickets.set(ticket, { user: u, code, exp: Date.now() + OFFICIAL_CODE_TTL, tries: 0 });
      // 顺手清掉过期的票据，别让 Map 一直长
      for (const [k, v] of officialTickets) if (v.exp < Date.now()) officialTickets.delete(k);
      try {
        await mail.sendMail({
          to: OFFICIAL_EMAIL,
          subject: '联机贪吃蛇 · 官方账号登录验证码',
          text: '你的官方账号登录验证码是：' + code + '\n\n10 分钟内有效，只能用来登录官方账号。\n'
              + '如果这不是你本人操作，请立刻改密码。'
        });
      } catch (e){
        officialTickets.delete(ticket);
        console.log('官方验证码发信失败：' + e.message);
        return sendJSON(res, 503, { ok:false, msg:'验证码没发出去，稍后再试一次', key:'officialMailFail' });
      }
      if (process.env.OFFICIAL_DEV_PRINT === '1') console.log('[official-dev] 验证码 ' + code + ' → ' + OFFICIAL_EMAIL);
      return sendJSON(res, 200, {
        ok:false, needOfficialCode:true, ticket, email: OFFICIAL_EMAIL,
        msg:'验证码已发到官方邮箱，10 分钟内有效', key:'needOfficialCode'
      });
    }
    const token = newToken(u, req);
    if (!token) return sendJSON(res, 403, { ok:false, msg:'官方账号只能在授权设备上登录', key:'officialGuard' });
    return sendJSON(res, 200, {ok:true, token, user:u, muteLeft: muteLeftOf(u)}, {'Set-Cookie': authCookie(token)});
  }
  // 官方账号第二步：一次性票据 + 邮箱验证码 → 换令牌
  if (req.method === 'POST' && urlPath === '/api/official/code'){
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const ticket = String(body.ticket || '').trim();
    const code = String(body.code || '').replace(/[^0-9]/g, '');
    const rec = officialTickets.get(ticket);
    if (!rec || rec.exp < Date.now()){
      officialTickets.delete(ticket);
      return sendJSON(res, 400, {ok:false,msg:'验证码已过期，请重新登录', key:'officialTicketExpired'});
    }
    // 定长比较，别用 === 泄露长度差异
    const cb = Buffer.from(code), ob = Buffer.from(String(rec.code || ''));
    const same = cb.length === ob.length && crypto.timingSafeEqual(cb, ob);
    if (!same){
      rec.tries = (rec.tries || 0) + 1;
      if (rec.tries >= 5){
        officialTickets.delete(ticket);
        return sendJSON(res, 429, {ok:false,msg:'验证码错太多次了，重新登录再来', key:'officialCodeLocked'});
      }
      return sendJSON(res, 403, {ok:false,msg:'验证码不对', key:'officialCodeWrong'});
    }
    officialTickets.delete(ticket);
    const token = newToken(rec.user, req, true);
    return sendJSON(res, 200, {ok:true, token, user:rec.user, muteLeft: muteLeftOf(rec.user)}, {'Set-Cookie': authCookie(token)});
  }

  // 游客试玩：不注册、不写文件，拿一个临时身份进大厅
  if (req.method === 'POST' && urlPath === '/api/guest'){
    const u = newGuestName();
    guests.add(u);
    const token = newToken(u, req);
    return sendJSON(res, 200, {ok:true, token, user:u, guest:true, muteLeft:0}, {'Set-Cookie': authCookie(token)});
  }
  if (req.method === 'POST' && urlPath === '/api/logout'){
    // 清掉 Cookie；token 本身继续有效（同 token 多连接场景复杂）
    return sendJSON(res, 200, {ok:true}, {'Set-Cookie': AUTH_COOKIE_CLEAR});
  }
  // 注销账号：需 token + 密码确认，删除账号/排行榜/所有登录态
  if (req.method === 'POST' && urlPath === '/api/delete-account'){
    const u = authFromReq(req);
    if (!u) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    if (u === OFFICIAL_NAME) return sendJSON(res, 403, {ok:false,msg:'官方账号不允许注销'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const p = String(body.p||'');
    const a = accounts.get(u);
    if (!a || !verifyPass(p, a.salt, a.hash)) return sendJSON(res,401,{ok:false,msg:'密码不对，注销失败'});
    accounts.delete(u);
    saveUsers();
    cleanupSocial(u);
    cleanupGroups(u);
    leaderboard = leaderboard.filter(x=>x.u!==u);
    saveScores();
    for (const [t, user] of [...tokens.entries()]) if (user===u) tokens.delete(t);
    return sendJSON(res, 200, {ok:true}, {'Set-Cookie': AUTH_COOKIE_CLEAR});
  }
  if (req.method === 'GET' && urlPath === '/api/me'){
    const u = authFromReq(req);
    if (!u) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const score = leaderboard.find(x=>x.u===u);
    return sendJSON(res, 200, {ok:true, user:u, best: score ? score.s : 0, muteLeft: muteLeftOf(u), guest:isGuest(u), official: u === OFFICIAL_NAME});
  }
  // —— 皮肤商店 / 签到 / 金币 ——
  if (req.method === 'GET' && urlPath === '/api/shop'){
    const u = authFromReq(req);
    if (!u) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    if (isGuest(u)) return sendJSON(res, 200, {ok:true, guest:true, coins:0, skin:'classic', owned:[], checkedToday:false, streak:0, skins:SKINS});
    const a = accounts.get(u);
    const today = dayKey();
    return sendJSON(res, 200, {
      ok:true, guest:false,
      coins: a.coins || 0,
      skin: a.skin || 'classic',
      owned: ownedSkinsOf(u, a),
      streak: a.lastCheckin ? (a.streak || 0) : 0,
      checkedToday: a.lastCheckin === today,
      skins: SKINS
    });
  }
  if (req.method === 'POST' && urlPath === '/api/shop/checkin'){
    const u = authFromReq(req);
    if (!u) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    if (isGuest(u)) return sendJSON(res, 403, {ok:false,msg:'游客不能领金币，注册个账号再来', key:'guestNoCoin'});
    const a = accounts.get(u);
    const today = dayKey();
    if (a.lastCheckin === today) return sendJSON(res, 400, {ok:false,msg:'今天已经签到过了，明天再来', key:'checkedToday', coins:a.coins||0});
    const streak = a.lastCheckin === prevDayKey(today) ? (a.streak || 0) + 1 : 1;
    const reward = checkinReward(streak);
    a.streak = streak;
    a.lastCheckin = today;
    a.coins = (a.coins || 0) + reward;
    saveUsers();
    return sendJSON(res, 200, {ok:true, reward, coins:a.coins, streak, checkedToday:true});
  }
  if (req.method === 'POST' && urlPath === '/api/shop/buy'){
    const u = authFromReq(req);
    if (!u) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    if (isGuest(u)) return sendJSON(res, 403, {ok:false,msg:'游客不能买皮肤，注册个账号再来', key:'guestNoSkin'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const sk = skinById(body.id);
    if (!sk) return sendJSON(res, 404, {ok:false,msg:'没有这个皮肤'});
    const a = accounts.get(u);
    a.owned = a.owned || [];
    if (isOfficial(u))
      return sendJSON(res, 400, {ok:false,msg:'官方账号皮肤全部解锁，直接换就行', key:'officialAllSkins'});
    if (a.owned.includes(sk.id) || sk.id === 'classic')
      return sendJSON(res, 400, {ok:false,msg:'这个皮肤你已经有了', key:'alreadyOwned'});
    if ((a.coins || 0) < sk.price)
      return sendJSON(res, 400, {ok:false,msg:'金币不够，还差 ' + (sk.price - (a.coins||0)) + ' 个', key:'noEnoughCoins'});
    a.coins = (a.coins || 0) - sk.price;
    a.owned.push(sk.id);
    a.skin = sk.id;             // 买完直接穿上
    saveUsers();
    return sendJSON(res, 200, {ok:true, coins:a.coins, skin:a.skin, owned:a.owned});
  }
  if (req.method === 'POST' && urlPath === '/api/shop/equip'){
    const u = authFromReq(req);
    if (!u) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const sk = skinById(body.id);
    if (!sk) return sendJSON(res, 404, {ok:false,msg:'没有这个皮肤'});
    const a = accounts.get(u) || {};
    if (!ownedSkinsOf(u, a).includes(sk.id))
      return sendJSON(res, 403, {ok:false,msg:'还没买这个皮肤', key:'notOwned'});
    a.skin = sk.id;
    if (!isGuest(u)) { accounts.set(u, a); saveUsers(); }
    return sendJSON(res, 200, {ok:true, skin:sk.id});
  }
  // 用 Cookie 换一个能用的 token：页面读不到 httpOnly Cookie 时靠它恢复 WebSocket 身份
  if (req.method === 'GET' && urlPath === '/api/platform'){
    return sendJSON(res, 200, {ok:true, platform:detectPlatform(req.headers['user-agent']), ua:String(req.headers['user-agent'] || '').slice(0, 240)}, {'Cache-Control':'no-store'});
  }
  if (req.method === 'POST' && urlPath === '/api/token'){
    const u = authFromReq(req);
    if (!u) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const token = newToken(u, req);
    if (!token) return sendJSON(res, 403, {ok:false,msg:'官方账号只能在授权设备上登录', key:'officialGuard'});
    return sendJSON(res, 200, {ok:true, token, user:u, muteLeft:muteLeftOf(u), guest:isGuest(u)}, {'Set-Cookie': authCookie(token)});
  }
  if (req.method === 'GET' && urlPath === '/api/stats'){
    return sendJSON(res, 200, { ok:true, accounts: accounts.size, leaderboard: leaderboard.length, guests: guests.size });
  }
  if (req.method === 'GET' && urlPath === '/api/scores'){
    return sendJSON(res, 200, {ok:true, items: leaderboard.slice(0,20).map(x => ({ ...x, off: isOfficial(x.u) }))});
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

  // 前端从这里取 hCaptcha 的 Site Key；没配置就返回空串，页面不显示组件
  if (req.method === 'GET' && urlPath === '/api/config'){
    return sendJSON(res, 200, {
      ok: true,
      siteKey: HCAPTCHA_SITE_KEY,
      captchaRequired: !!HCAPTCHA_SECRET && !!HCAPTCHA_SITE_KEY,
      officialCodeReady: mailSendable(),
      oauthBase: OAUTH_BASE,
      oauth: {
        microsoft: oauthReady('microsoft'),
        google: oauthReady('google'),
        github: oauthReady('github')
      },
      sms: !!smsProvider() || process.env.SMS_DEV_ECHO === '1'
    });
  }

  // —— 第三方快捷登录（start / callback / exchange）——
  if (urlPath.startsWith('/api/oauth/')) return handleOauth(req, res, urlPath);

  // —— 手机号验证码：发送 ——
  if (req.method === 'POST' && urlPath === '/api/sms/send'){
    const devEcho = process.env.SMS_DEV_ECHO === '1';
    if (!smsProvider() && !devEcho) return sendJSON(res, 400, { ok:false, msg:'短信服务还没配置', key:'smsFail' });
    const body = await readBody(req);
    const phone = normPhone(body.phone);
    if (!phone) return sendJSON(res, 400, { ok:false, msg:'手机号格式不对', key:'phoneBad' });
    // 测试开关只对白名单号码生效，其它号码一律当作未配置，避免公开接口变成任意登录后门
    const devPhone = normPhone(process.env.SMS_DEV_PHONE || '');
    const devHit = devEcho && (!devPhone || phone === devPhone);
    if (!smsProvider() && !devHit) return sendJSON(res, 400, { ok:false, msg:'短信服务还没配置', key:'smsFail' });
    const now = Date.now();
    if (now - (smsCooldown.get(phone) || 0) < 60000)
      return sendJSON(res, 429, { ok:false, msg:'请等 1 分钟再发', key:'smsWait' });
    const ip = clientIp(req);
    const rec = smsIpHits.get(ip) || { n: 0, t: now };
    if (now - rec.t > 3600000){ rec.n = 0; rec.t = now; }
    if (rec.n >= 10) return sendJSON(res, 429, { ok:false, msg:'发送太频繁，请稍后再试', key:'smsWait' });
    const code = String(crypto.randomInt(100000, 1000000));
    let ok = true;
    if (smsProvider()) ok = await sendSmsCode(phone, code);
    else console.log('[sms-dev] 验证码', phone, code);
    if (!ok) return sendJSON(res, 502, { ok:false, msg:'短信发送失败，请稍后再试', key:'smsFail' });
    smsCodes.set(phone, { code, exp: now + 10 * 60 * 1000 });
    smsCooldown.set(phone, now);
    rec.n++;
    smsIpHits.set(ip, rec);
    return sendJSON(res, 200, devHit ? { ok:true, devCode: code } : { ok:true });
  }

  // —— 手机号验证码：登录（没有账号就自动建）——
  if (req.method === 'POST' && urlPath === '/api/phone-login'){
    const body = await readBody(req);
    const phone = normPhone(body.phone);
    const code = String(body.code || '');
    const rec = phone ? smsCodes.get(phone) : null;
    if (!rec || rec.exp < Date.now() || rec.code !== code)
      return sendJSON(res, 400, { ok:false, msg:'验证码不对或已过期', key:'smsFail' });
    smsCodes.delete(phone);
    const ip = clientIp(req);
    const banMsg = bannedHit(phone, ip);
    if (banMsg) return sendJSON(res, 403, { ok:false, msg: banMsg, key:'bannedMsg' });
    let user = accountByPhone(phone);
    if (!user){
      user = usernameFromPhone(phone);
      const { hash, salt } = hashPass(crypto.randomBytes(12).toString('hex'));
      accounts.set(user, { hash, salt, email:'', phone, ip });
      saveUsers();
    }
    const token = newToken(user, req);
    if (!token) return sendJSON(res, 403, { ok:false, msg:'官方账号只能在授权设备上登录', key:'officialGuard' });
    return sendJSON(res, 200, { ok:true, token, user, muteLeft: muteLeftOf(user) }, { 'Set-Cookie': authCookie(token) });
  }

  // —— 好友 API ——
  // 所有玩家（带在线状态和我和他的关系）
  if (req.method === 'GET' && urlPath === '/api/players'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const items = [...accounts.keys()].filter(u => u !== me).map(u => ({
      u, best: bestOf(u), online: isOnline(u), relation: relationOf(me, u), off: isOfficial(u)
    })).sort((a,b) => (b.online - a.online) || a.u.localeCompare(b.u, 'zh'));
    return sendJSON(res, 200, {ok:true, items});
  }
  // 我的好友 + 待处理的好友申请
  if (req.method === 'GET' && urlPath === '/api/friends'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    // 游客没有好友：不加官方、不读写 friends.json
    if (isGuest(me)) return sendJSON(res, 200, {ok:true, friends:[], requests:[]});
    const friends = friendListOf(me).map(u => ({ u, online:isOnline(u), best:bestOf(u), off:isOfficial(u) }));
    const requests = (social.reqs[me] || []).map(r => ({ from:r.from, ts:r.ts }));
    return sendJSON(res, 200, {ok:true, friends, requests});
  }
  // 游客不能加好友 / 私聊：这些记录会写进 friends.json，游客要求不留痕
  if (/^\/api\/friend\//.test(urlPath) && isGuest(authFromReq(req) || '')){
    return sendJSON(res, 403, {ok:false,msg:'游客不能用好友功能，注册账号后就可以啦'});
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
    if (u === OFFICIAL_NAME) return sendJSON(res, 403, {ok:false,msg:'官方好友不能删除'});
    social.friends[me] = (social.friends[me] || []).filter(x => x !== u);
    if (!social.friends[me].length) delete social.friends[me];
    social.friends[u] = (social.friends[u] || []).filter(x => x !== me);
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
    const k = pairKey(me, withWho);
    let items = social.msgs[k] || [];
    // 打开和官方的私聊就先把欢迎语放进去，不用等对方先说话
    if (withWho === OFFICIAL_NAME && !items.length){
      const greeting = { id: nextMid(), from: OFFICIAL_NAME, text: OFFICIAL_AUTO_REPLY, ts: Date.now() };
      items = [greeting];
      social.msgs[k] = items;
      saveSocial();
    } else if (ensureMsgIds(items)){
      saveSocial();   // 老记录补上 id，撤回才有对象
    }
    return sendJSON(res, 200, {ok:true, items: items.slice(-100)});
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
    const item = { id: nextMid(), from: me, text, ts: Date.now() };
    arr.push(item);
    if (arr.length > 100) arr.splice(0, arr.length - 100);
    saveSocial();
    pushToUser(to, { t:'friend_msg', id:item.id, from: me, text, ts: item.ts });
    if (to === OFFICIAL_NAME) maybeOfficialReply(me);   // 给官方发消息会自动收到一条说明
    return sendJSON(res, 200, {ok:true, item});
  }
  // 撤回私聊消息：只有发送者本人、5 分钟内有效
  if (req.method === 'POST' && urlPath === '/api/friend/recall'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const to = String(body.to||'').trim();
    const mid = String(body.mid||'').trim();
    if (!to || !mid) return sendJSON(res, 400, {ok:false,msg:'参数不完整'});
    const arr = social.msgs[pairKey(me, to)];
    if (!arr) return sendJSON(res, 404, {ok:false,msg:'找不到这条消息', key:'recallMissing'});
    const idx = arr.findIndex(m => m && m.id === mid);
    if (idx < 0) return sendJSON(res, 404, {ok:false,msg:'找不到这条消息', key:'recallMissing'});
    const item = arr[idx];
    if (item.recalled) return sendJSON(res, 400, {ok:false,msg:'这条消息已经撤回过了', key:'recallDone'});
    if (item.from !== me) return sendJSON(res, 403, {ok:false,msg:'只能撤回自己发的消息', key:'recallSelfOnly'});
    if (Date.now() - item.ts > RECALL_TTL)
      return sendJSON(res, 400, {ok:false,msg:'超过 5 分钟，撤不回来了', key:'recallTooLate'});
    item.recalled = true;   // 留个占位，历史里还能看到"已撤回"
    item.text = '';
    saveSocial();
    pushToUser(to, { t:'friend_recall', with: me, mid, ts: Date.now() });
    return sendJSON(res, 200, {ok:true});
  }
  // —— 通过邮箱验证码重置密码 ——
  // 验证码只发到账号已绑定的邮箱，前端传不了别的地址
  if (req.method === 'POST' && urlPath === '/api/reset_code'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'请先登录'});
    if (isGuest(me)) return sendJSON(res, 403, {ok:false,msg:'游客没有绑定邮箱，不能重置密码'});
    const acc = accounts.get(me);
    const email = acc && acc.email;
    if (!email) return sendJSON(res, 400, {ok:false,msg:'这个账号没有绑定邮箱，无法重置密码'});
    if (!mailUsable()) return sendJSON(res, 503, {ok:false,msg:'邮箱服务暂时不可用，请稍后再试'});
    const key = 'reset:' + me;
    const last = codeCooldown.get(key) || 0;
    if (Date.now() - last < CODE_GAP){
      return sendJSON(res, 429, {ok:false,msg:'发太频繁了，' + Math.ceil((CODE_GAP - (Date.now() - last)) / 1000) + ' 秒后再试'});
    }
    const code = String(100000 + randInt(900000));
    resetCodes.set(me, { code, exp: Date.now() + CODE_TTL, tries: 0 });
    codeCooldown.set(key, Date.now());
    try {
      await mail.sendMail({
        to: email,
        subject: '联机贪吃蛇 · 重置密码验证码',
        code,
        purpose: '重置密码',
        text: '你正在重置账号「' + me + '」的密码，验证码是：' + code + '\n\n10 分钟内有效。\n如果不是你本人操作，请忽略这封邮件，并尽快修改密码。'
      });
    } catch (e){
      resetCodes.delete(me);
      console.log('重置密码发信失败：' + e.message);
      return sendJSON(res, 500, {ok:false,msg:'邮件发送失败：' + e.message});
    }
    const [name, domain] = email.split('@');
    return sendJSON(res, 200, {ok:true, msg:'验证码已发到 ' + name.slice(0, 2) + '***@' + domain + '，10 分钟内有效'});
  }

  if (req.method === 'POST' && urlPath === '/api/reset_pass'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'请先登录'});
    if (isGuest(me)) return sendJSON(res, 403, {ok:false,msg:'游客不能重置密码'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const rec = resetCodes.get(me);
    if (!rec || rec.exp < Date.now()){
      resetCodes.delete(me);
      return sendJSON(res, 400, {ok:false,msg:'验证码已过期，请重新发送'});
    }
    if (rec.tries >= 5){
      resetCodes.delete(me);
      return sendJSON(res, 429, {ok:false,msg:'错误次数太多，请重新发送验证码'});
    }
    if (String(body.code || '').trim() !== rec.code){
      rec.tries++;
      return sendJSON(res, 400, {ok:false,msg:'验证码不对，还可以试 ' + (5 - rec.tries) + ' 次'});
    }
    const np = String(body.pass || '');
    if (np.length < 4 || np.length > 32) return sendJSON(res, 400, {ok:false,msg:'新密码要 4-32 位'});
    const acc = accounts.get(me);
    const p = hashPass(np);
    acc.hash = p.hash;
    acc.salt = p.salt;
    saveUsers();
    resetCodes.delete(me);
    // 其他设备上的登录态一并失效，当前这台保留
    const cur = (req.headers.authorization || '').trim().slice(7);
    for (const [t, u2] of [...tokens.entries()]) if (u2 === me && t !== cur) tokens.delete(t);
    return sendJSON(res, 200, {ok:true, msg:'密码已重置'});
  }

  // —— 改名：账号名整体迁移（账号、排行榜、登录态、好友、私聊）——
  if (req.method === 'POST' && urlPath === '/api/rename'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'请先登录'});
    if (isGuest(me)) return sendJSON(res, 403, {ok:false,msg:'游客不能改名，注册账号后才可以'});
    if (me === OFFICIAL_NAME) return sendJSON(res, 403, {ok:false,msg:'官方账号不能改名'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const nu = String(body.name||'').trim();
    if (!nu || nu.length>16 || /[^\w\u4e00-\u9fa5]/.test(nu))
      return sendJSON(res, 400, {ok:false,msg:'用户名 1-16 字，只允许字母/数字/中文'});
    if (nu === me) return sendJSON(res, 400, {ok:false,msg:'和现在的名字一样'});
    if (accounts.has(nu)) return sendJSON(res, 409, {ok:false,msg:'用户名已存在'});
    if (guests.has(nu)) return sendJSON(res, 409, {ok:false,msg:'这个名字正被游客使用，换一个吧'});
    if (hasBannedWord(nu)) return sendJSON(res, 400, {ok:false,msg:'用户名含有不允许的字词，换一个吧'});

    // 1) 账号本体（密码、邮箱、处罚记录原样带走）
    const acc = accounts.get(me);
    accounts.delete(me);
    accounts.set(nu, acc);
    // 2) 排行榜
    for (const e of leaderboard) if (e.u === me) e.u = nu;
    // 3) 登录态：token 不变，只把指向改掉，前端不用重新登录
    for (const [t, u2] of [...tokens.entries()]) if (u2 === me) tokens.set(t, nu);
    // 4) 好友关系与待处理申请
    if (social.friends[me]){ social.friends[nu] = social.friends[me]; delete social.friends[me]; }
    for (const k in social.friends) social.friends[k] = social.friends[k].map(x => x === me ? nu : x);
    if (social.reqs[me]){ social.reqs[nu] = social.reqs[me]; delete social.reqs[me]; }
    for (const k in social.reqs) for (const r of social.reqs[k]) if (r.from === me) r.from = nu;
    // 5) 私聊：会话键由两个名字排序拼接，改名后要重建
    const nmsgs = {};
    for (const k in social.msgs){
      const nk = k.split('|').map(x => x === me ? nu : x).sort().join('|');
      const list = social.msgs[k];
      for (const m of list) if (m.from === me) m.from = nu;
      nmsgs[nk] = (nmsgs[nk] || []).concat(list);
    }
    social.msgs = nmsgs;
    // 6) 在线连接与房间内显示名
    const sockSet = socketsByUser.get(me);
    if (sockSet){
      socketsByUser.delete(me);
      socketsByUser.set(nu, sockSet);
      for (const ws of sockSet) ws.user = nu;
    }
    for (const rm of rooms.values())
      for (const p of rm.players.values()) if (p.name === me) p.name = nu;

    saveUsers(); saveScores(); saveSocial();
    return sendJSON(res, 200, {ok:true, user:nu, msg:'改名成功'});
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
    if (isOfficial(u)) return sendJSON(res, 403, {ok:false,msg:'官方账号不允许注销'});
    banAccount(accounts.get(u));   // 管理员删号也进黑名单
    accounts.delete(u);
    saveUsers();
    cleanupSocial(u);
    cleanupGroups(u);
    leaderboard = leaderboard.filter(x=>x.u!==u);
    saveScores();
    for (const [t, user] of [...tokens.entries()]) if (user===u) tokens.delete(t);
    return sendJSON(res, 200, {ok:true});
  }
  // ========== 群组 ==========
  if (req.method === 'GET' && urlPath === '/api/groups'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const items = Object.values(groups).filter(g => (g.members||[]).includes(me)).map(g => groupBrief(g, me));
    return sendJSON(res, 200, {ok:true, items, max:GROUP_MAX_OWNED, owned: groupsOwnedBy(me).length});
  }
  if (req.method === 'POST' && urlPath === '/api/group/create'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    if (guests.has(me)) return sendJSON(res, 403, {ok:false,msg:'游客不能建群，先注册吧', key:'groupGuest'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const name = String(body.name||'').trim().slice(0,16);
    if (!name) return sendJSON(res, 400, {ok:false,msg:'群名不能为空', key:'groupNameBad'});
    if (hasBannedWord(name)) return sendJSON(res, 400, {ok:false,msg:'群名含有不允许的字词', key:'groupNameBad'});
    if (groupsOwnedBy(me).length >= GROUP_MAX_OWNED)
      return sendJSON(res, 400, {ok:false,msg:'每人最多创建 5 个群，请先删除几个群', key:'groupMax'});
    const id = newGroupId();
    groups[id] = { id, name, owner: me, members:[me], reqs:[], msgs:[], ts: Date.now() };
    saveGroups();
    return sendJSON(res, 200, {ok:true, group: groupBrief(groups[id], me)});
  }
  if (req.method === 'POST' && urlPath === '/api/group/find'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const q = String(body.q||'').trim().toLowerCase();
    if (!q) return sendJSON(res, 200, {ok:true, items:[]});
    const items = Object.values(groups)
      .filter(g => g.name.toLowerCase().includes(q) || g.id === q)
      .slice(0, 20)
      .map(g => ({ id:g.id, name:g.name, count:(g.members||[]).length,
        joined:(g.members||[]).includes(me), applied:(g.reqs||[]).some(r => r.from === me) }));
    return sendJSON(res, 200, {ok:true, items});
  }
  if (req.method === 'POST' && urlPath === '/api/group/apply'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const g = groups[String(body.id||'')];
    if (!g) return sendJSON(res, 404, {ok:false,msg:'群不存在', key:'groupNotFound'});
    if ((g.members||[]).includes(me)) return sendJSON(res, 200, {ok:true, already:true, msg:'你已经在这个群里了'});
    if ((g.reqs||[]).some(r => r.from === me)) return sendJSON(res, 200, {ok:true, applied:true, msg:'已经申请过了，等群主同意'});
    g.reqs = g.reqs || [];
    g.reqs.push({ from: me, ts: Date.now() });
    saveGroups();
    pushToUser(g.owner, { t:'group_req', id:g.id, name:g.name, from:me });
    return sendJSON(res, 200, {ok:true});
  }
  if (req.method === 'POST' && urlPath === '/api/group/detail'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const g = groups[String(body.id||'')];
    if (!g) return sendJSON(res, 404, {ok:false,msg:'群不存在', key:'groupNotFound'});
    if (!(g.members||[]).includes(me)) return sendJSON(res, 403, {ok:false,msg:'你还不是这个群的成员', key:'groupNotMember'});
    if (ensureMsgIds(g.msgs || [])) saveGroups();   // 老消息补 id，撤回才有对象
    return sendJSON(res, 200, {ok:true, group:{
      id:g.id, name:g.name, owner:g.owner, members:g.members.slice(),
      reqs: g.owner === me ? (g.reqs||[]) : [],
      msgs: (g.msgs||[]).slice(-100)
    }});
  }
  if (req.method === 'POST' && urlPath === '/api/group/accept'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const g = groups[String(body.id||'')];
    if (!g) return sendJSON(res, 404, {ok:false,msg:'群不存在', key:'groupNotFound'});
    if (g.owner !== me) return sendJSON(res, 403, {ok:false,msg:'只有群主能同意申请', key:'groupNotOwner'});
    const from = String(body.user||'').trim();
    if (!(g.reqs||[]).some(r => r.from === from)) return sendJSON(res, 404, {ok:false,msg:'没有这条申请', key:'groupNoReq'});
    g.reqs = g.reqs.filter(r => r.from !== from);
    if (!(g.members||[]).includes(from)) g.members.push(from);
    saveGroups();
    pushToUser(from, { t:'group_join', id:g.id, name:g.name });
    pushGroupMembers(g, { t:'group_member', id:g.id, name:g.name, from }, from);
    return sendJSON(res, 200, {ok:true});
  }
  if (req.method === 'POST' && urlPath === '/api/group/reject'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const g = groups[String(body.id||'')];
    if (!g) return sendJSON(res, 404, {ok:false,msg:'群不存在', key:'groupNotFound'});
    if (g.owner !== me) return sendJSON(res, 403, {ok:false,msg:'只有群主能拒绝申请', key:'groupNotOwner'});
    const from = String(body.user||'').trim();
    g.reqs = (g.reqs||[]).filter(r => r.from !== from);
    saveGroups();
    return sendJSON(res, 200, {ok:true});
  }
  if (req.method === 'POST' && (urlPath === '/api/group/kick' || urlPath === '/api/group/leave')){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const g = groups[String(body.id||'')];
    if (!g) return sendJSON(res, 404, {ok:false,msg:'群不存在', key:'groupNotFound'});
    if (!(g.members||[]).includes(me)) return sendJSON(res, 403, {ok:false,msg:'你还不是这个群的成员', key:'groupNotMember'});
    const isKick = urlPath === '/api/group/kick';
    const target = isKick ? String(body.user||'').trim() : me;
    if (isKick && g.owner !== me) return sendJSON(res, 403, {ok:false,msg:'只有群主能踢人', key:'groupNotOwner'});
    if (target === g.owner) return sendJSON(res, 400, {ok:false,msg:'群主不能退出，请直接解散群', key:'groupOwnerLeave'});
    g.members = g.members.filter(x => x !== target);
    saveGroups();
    if (isKick) pushToUser(target, { t:'group_kick', id:g.id, name:g.name });
    pushGroupMembers(g, { t:'group_member', id:g.id, name:g.name, from:target }, target);
    return sendJSON(res, 200, {ok:true});
  }
  if (req.method === 'POST' && urlPath === '/api/group/delete'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const g = groups[String(body.id||'')];
    if (!g) return sendJSON(res, 404, {ok:false,msg:'群不存在', key:'groupNotFound'});
    if (g.owner !== me) return sendJSON(res, 403, {ok:false,msg:'只有群主能解散群', key:'groupNotOwner'});
    delete groups[g.id];
    saveGroups();
    pushGroupMembers(g, { t:'group_delete', id:g.id, name:g.name });
    return sendJSON(res, 200, {ok:true});
  }
  if (req.method === 'POST' && urlPath === '/api/group/chat'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const g = groups[String(body.id||'')];
    if (!g) return sendJSON(res, 404, {ok:false,msg:'群不存在', key:'groupNotFound'});
    if (!(g.members||[]).includes(me)) return sendJSON(res, 403, {ok:false,msg:'你还不是这个群的成员', key:'groupNotMember'});
    const text = String(body.text||'').trim().slice(0, 200);
    if (!text) return sendJSON(res, 400, {ok:false,msg:'不能发空消息'});
    const item = { id: nextMid(), from: me, text, ts: Date.now() };
    g.msgs = g.msgs || [];
    g.msgs.push(item);
    if (g.msgs.length > GROUP_MSG_KEEP) g.msgs.splice(0, g.msgs.length - GROUP_MSG_KEEP);
    saveGroups();
    pushGroupMembers(g, { t:'group_msg', id:g.id, mid:item.id, from:me, text, ts:item.ts }, me);
    return sendJSON(res, 200, {ok:true, item});
  }
  // 撤回群消息：只有发送者本人、5 分钟内有效
  if (req.method === 'POST' && urlPath === '/api/group/recall'){
    const me = authFromReq(req);
    if (!me) return sendJSON(res, 401, {ok:false,msg:'未登录'});
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, {ok:false,msg:'请求格式错误'});
    const g = groups[String(body.id||'')];
    if (!g) return sendJSON(res, 404, {ok:false,msg:'群不存在', key:'groupNotFound'});
    if (!(g.members||[]).includes(me)) return sendJSON(res, 403, {ok:false,msg:'你还不是这个群的成员', key:'groupNotMember'});
    const mid = String(body.mid||'').trim();
    if (!mid) return sendJSON(res, 400, {ok:false,msg:'参数不完整'});
    g.msgs = g.msgs || [];
    const idx = g.msgs.findIndex(m => m && m.id === mid);
    if (idx < 0) return sendJSON(res, 404, {ok:false,msg:'找不到这条消息', key:'recallMissing'});
    const item = g.msgs[idx];
    if (item.recalled) return sendJSON(res, 400, {ok:false,msg:'这条消息已经撤回过了', key:'recallDone'});
    if (item.from !== me) return sendJSON(res, 403, {ok:false,msg:'只能撤回自己发的消息', key:'recallSelfOnly'});
    if (Date.now() - item.ts > RECALL_TTL)
      return sendJSON(res, 400, {ok:false,msg:'超过 5 分钟，撤不回来了', key:'recallTooLate'});
    item.recalled = true;   // 留个占位，历史里还能看到"已撤回"
    item.text = '';
    saveGroups();
    pushGroupMembers(g, { t:'group_recall', id:g.id, mid, from:me, ts:Date.now() }, me);
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
      const user = tokens.get(msg.token) || (ws.cookieToken ? tokens.get(ws.cookieToken) : null);
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
      if (isGuest(ws.user)) return ws.sendText(JSON.stringify({t:'sys',msg:'游客不能开房间，挑一个房间加入吧', key:'guestNoCreate'}));
      const name = String(msg.name||'').trim().slice(0, 20);
      if (!name) return ws.sendText(JSON.stringify({t:'sys',msg:'房间名不能为空', key:'needRoomName'}));
      if (hasBannedWord(name)) return ws.sendText(JSON.stringify({t:'sys',msg:'房间名含有不允许的字词', key:'badRoomName'}));
      if (rooms.size >= 50) return ws.sendText(JSON.stringify({t:'sys',msg:'房间数已达上限', key:'roomLimit'}));
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
    // 单人模式：开一间私密房，塞一个派派进去陪打
    if (msg.t === 'solo'){
      if (isGuest(ws.user)) return ws.sendText(JSON.stringify({t:'sys',msg:'游客不能开房间，进别人的房间就能玩', key:'guestNoCreate2'}));
      if (rooms.size >= 50) return ws.sendText(JSON.stringify({t:'sys',msg:'房间数已达上限', key:'roomLimit'}));
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
      // 四档难度全部由派派出场，只改参数，不再有第二个 AI
      const DIFFS = ['easy', 'normal', 'hard', 'nightmare'];
      const rawDiff = String(msg.diff || '').toLowerCase();
      const diff = DIFFS.includes(rawDiff) ? rawDiff : 'normal';
      r.addBot('派派', 'pai', diff);
      broadcastRooms();
      return;
    }
    if (msg.t === 'join_room'){
      const id = String(msg.id||'').trim();
      const r = rooms.get(id);
      if (!r) return ws.sendText(JSON.stringify({t:'sys',msg:'房间不存在', key:'noSuchRoom'}));
      if (r.isSolo) return ws.sendText(JSON.stringify({t:'sys',msg:'这是别人的单人房', key:'soloOther'}));
      if (r.hasPassword() && String(msg.pass||'') !== r.pass) return ws.sendText(JSON.stringify({t:'sys',msg:'密码不对', key:'badPass'}));
      if (r.count >= MAX_PLAYERS_PER_ROOM) return ws.sendText(JSON.stringify({t:'sys',msg:'房间已满', key:'roomFull'}));
      r.addPlayer(ws, ws.user);
      broadcastRooms();
      return;
    }
    if (msg.t === 'chat'){
      const text = String(msg.text||'').trim().slice(0, 200);
      if (!text) return;
      // 游客不能在大厅发言（房间里可以聊）
      if (isGuest(ws.user)) return ws.sendText(JSON.stringify({t:'sys',msg:'游客不能在大厅发言，进房间后就能聊', key:'guestNoLobbyChat'}));
      if (blockChatIfNeeded(ws, text)) return;
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
      room.broadcast(JSON.stringify({t:'sys', msg: ws.user+' 把速度调成了 '+room.tickMs+'ms/步', key:'sysSpeed', args:{name:ws.user, ms:room.tickMs}}));
    } else {
      ws.sendText(JSON.stringify({t:'sys', msg: r.msg, key:r.key}));
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
  '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf',
  '.map':'application/json'
};

// ============================================================
//  上游代理：设了 UPSTREAM 就把接口和实时连接转给主服务，
//  两个域名共用同一套账号数据（本机静态页照旧自己提供）
// ============================================================
const UPSTREAM = process.env.UPSTREAM || '';
let upMod = null, UP = null;
if (UPSTREAM){
  UP = new URL(UPSTREAM);
  upMod = UP.protocol === 'https:' ? require('https') : http;
}
function upPort(){ return UP.port || (UP.protocol === 'https:' ? 443 : 80); }
function proxyHttp(req, res, urlPath){
  const preq = upMod.request({
    hostname: UP.hostname, port: upPort(), path: urlPath + (/[?]/.test(req.url) ? req.url.slice(req.url.indexOf('?')) : ''),
    method: req.method, headers: Object.assign({}, req.headers, { host: UP.host })
  }, pres => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', () => {
    try { res.writeHead(502, { 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok:false, msg:'主服务连接失败，请稍后重试' })); } catch {}
  });
  req.pipe(preq);
}
function proxyUpgrade(req, socket){
  const preq = upMod.request({
    hostname: UP.hostname, port: upPort(), path: req.url, method: 'GET',
    headers: Object.assign({}, req.headers, { host: UP.host })
  });
  preq.on('upgrade', (pres, psock, phead) => {
    let head = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const k in pres.headers) head += k + ': ' + pres.headers[k] + '\r\n';
    socket.write(head + '\r\n');
    if (phead && phead.length) socket.write(phead);
    psock.pipe(socket); socket.pipe(psock);
    socket.on('error', () => psock.destroy());
    psock.on('error', () => socket.destroy());
  });
  preq.on('error', () => socket.destroy());
  preq.end();
}

// 可压缩的文本类扩展名 + 压缩结果缓存
const COMPRESSIBLE = new Set(['.html','.js','.css','.svg','.json','.txt','.xml','.map','.webmanifest']);
// 安装包：换包后必须立刻拿到新版，不给浏览器留旧缓存
const RELEASE_EXT = new Set(['.dmg','.zip','.apk','.ipa','.deb','.hap','.exe','.sb3','.tar','.gz']);
const gzipCache = new Map();

// 安装包不再由本站占流量：命中下面的文件名就 302 到 GitHub Releases（免费、无限流量）
// 用 latest/download 而不是写死某个版本号，发新版后站点自动跟上
const RELEASES_BASE = process.env.RELEASES_URL
  || 'https://github.com/s2ys9jgn4d-star/snake-online/releases/latest/download';
const RELEASE_ASSET = {
  '贪吃蛇.dmg': 'snake-online.dmg',
  '贪吃蛇-unsigned.ipa': 'snake-online-unsigned.ipa',
  '贪吃蛇-win64.zip': 'snake-online-win64.zip',
  '贪吃蛇.apk': 'snake-online.apk',
  '贪吃蛇.deb': 'snake-online.deb',
  '联机贪吃蛇.sb3': 'snake-online.sb3'
};

const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end('Bad Request'); }

  // 代理模式：接口交给主服务，账号数据自然就是同一份
  if (UPSTREAM && urlPath.startsWith('/api/')) return proxyHttp(req, res, urlPath);

  // API 走异步处理器（先过全局限流）
  if (urlPath.startsWith('/api/')){
    const ip = clientIp(req), now = Date.now();
    const rec = apiHits.get(ip) || { n: 0, t: now };
    if (now - rec.t > 60000){ rec.n = 0; rec.t = now; }
    rec.n++;
    if (rec.n > API_HIT_LIMIT) return sendJSON(res, 429, { ok:false, msg:'请求太频繁，请稍后再试', key:'tooFast' });
    apiHits.set(ip, rec);
    if (apiHits.size > 2000) for (const [k, v] of apiHits) if (now - v.t > 300000) apiHits.delete(k);
  }
  if (urlPath.startsWith('/api/')) return handleApi(req, res, urlPath);

  if (urlPath === '/') urlPath = '/index.html';
  // 安装包直连 GitHub Releases，本站只回一个 302，不产生流量
  const asset = RELEASE_ASSET[path.basename(urlPath)];
  if (asset){
    res.writeHead(302, { Location: RELEASES_BASE + '/' + asset, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)){ res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err){ res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); return res.end('404'); }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Vary': 'Accept-Encoding' };
    // 页面每次校验（改了立刻生效）；脚本/样式带 ?v= 版本号，可以放心长缓存一天
    // 页面里的 ?v= 改成静态资源时间戳，脚本一改、地址就变，浏览器必须重新取
    if (ext === '.html') data = Buffer.from(data.toString('utf8').replace(/(\?v=)[0-9A-Za-z._-]+/g, '$1' + ASSET_STAMP));
    if (RELEASE_EXT.has(ext)) headers['Cache-Control'] = 'no-cache, must-revalidate';
    else if (ext === '.html') headers['Cache-Control'] = 'no-cache, must-revalidate';
    else headers['Cache-Control'] = 'public, max-age=86400';

    // gzip：文本类资源压一遍后缓存起来，反复访问不再重复压缩
    const gzipOk = /gzip/i.test(req.headers['accept-encoding'] || '') && COMPRESSIBLE.has(ext) && data.length > 1024;
    if (gzipOk){
      const hit = gzipCache.get(filePath);
      let gz;
      if (hit && hit.len === data.length) gz = hit.buf;
      else { gz = zlib.gzipSync(data); gzipCache.set(filePath, { len: data.length, buf: gz }); }
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = gz.length;
      res.writeHead(200, headers);
      return res.end(gz);
    }
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const headers = req.headers;
  if ((headers.upgrade||'').toLowerCase() !== 'websocket' || !headers['sec-websocket-key']){ socket.destroy(); return; }
  // 代理模式：实时连接也转给主服务，两个域名进的是同一批房间
  if (UPSTREAM) return proxyUpgrade(req, socket);
  const accept = crypto.createHash('sha1').update(headers['sec-websocket-key'] + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const ws = new WSSocket(socket);
  // 浏览器同源连接会自动带上 Cookie；离线包仍传 token
  ws.cookieToken = parseCookies(req)[AUTH_COOKIE] || '';
  onConnection(ws);
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

// 先从云备份恢复账号数据，空库再从私有仓库自举，最后开始监听
cloudRestore().then(seedFromRepo).finally(() => {
  ensureOfficialScore();   // 官方号不参与排行榜
  applyCleanupList();      // 一次性清掉早期测试账号（不拉黑）
  server.listen(PORT, () => {
    console.log('');
    console.log('  🐍 多人联机贪吃蛇（完整版：账号+房间+排行榜+聊天）');
    console.log('  本机：  http://localhost:'+PORT);
    for (const ip of lanIPs()) console.log('  同 Wi-Fi：http://'+ip+':'+PORT);
    console.log('  Ctrl+C 停止');
    console.log('');
  });
});
