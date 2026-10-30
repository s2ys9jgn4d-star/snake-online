'use strict';
/*
 * 多人联机贪吃蛇 —— 完整版客户端
 * 三状态机：auth → lobby → game
 * 协议增量见 server.js 顶部注释
 */

// ============================================================
//  页面切换
// ============================================================
const $ = id => document.getElementById(id);
const panels = { auth: $('panel-auth'), lobby: $('panel-lobby'), game: $('panel-game') };
let currentPanel = null;
function showPanel(name){
  if (currentPanel === name) return;
  currentPanel = name;
  panels.auth.classList.toggle('hidden', name !== 'auth');
  panels.lobby.classList.toggle('hidden', name !== 'lobby');
  panels.game.classList.toggle('hidden', name !== 'game');
}

// ============================================================
//  HTTP API（注册/登录/排行榜）
// ============================================================
// API 地址推导：与 WebSocket 同源逻辑
// - 同源（Mac 直接访问 / 局域网）：用 location.origin
// - 本机 server：file:// 或非 https 页面探测 localhost:8180
// - 其他（如 Cloudflare Pages）：用 Funnel 公网地址
const FALLBACK_WS = 'wss://niesdemacbook-air.tail4f9990.ts.net';
const FALLBACK_HTTP = 'https://niesdemacbook-air.tail4f9990.ts.net';
let API_BASE = FALLBACK_HTTP;  // 默认 Funnel，最稳
let WS_BASE_OVERRIDE = null;   // 探测到本机/同源服务器后覆盖

// 探测：同源是不是游戏服务器？本机有没有 server？都没有就保持 Funnel
async function detectLocalServer(){
  // 1. 同源探测（http/https 页面）
  if (/^https?:$/.test(location.protocol)) {
    try {
      const r = await fetch(location.origin + '/api/scores', { signal: AbortSignal.timeout(800) });
      if (r.ok){ API_BASE = location.origin; return; }
    } catch {}
  }
  // 2. 本机 server（https 页面会被 mixed-content 拦截，跳过）
  if (location.protocol !== 'https:') {
    try {
      const r = await fetch('http://localhost:8180/api/scores', { signal: AbortSignal.timeout(800) });
      if (r.ok){
        API_BASE = 'http://localhost:8180';
        WS_BASE_OVERRIDE = 'ws://localhost:8180';
        console.log('[snake] 检测到本机 server，切换到 localhost（低延迟模式）');
        return;
      }
    } catch {}
  }
  // 3. 默认 Funnel
}
let authToken = localStorage.getItem('snakeToken') || null;
let authUser = localStorage.getItem('snakeUser') || null;

async function api(path, opts={}){
  const h = {'Content-Type':'application/json'};
  if (authToken) h.Authorization = 'Bearer ' + authToken;
  const r = await fetch(API_BASE + path, { headers:h, ...opts });
  return r.json();
}

// —— 登录/注册标签切换 ——
let authTab = 'login';
$('authBtn').addEventListener('click', doAuthAction);
$('authPass').addEventListener('keydown', e => { if (e.key==='Enter') doAuthAction(); });
$('authUser').addEventListener('keydown', e => { if (e.key==='Enter') doAuthAction(); });
document.querySelectorAll('.auth-tabs .tab').forEach(b => {
  b.addEventListener('click', () => {
    authTab = b.dataset.tab;
    document.querySelectorAll('.auth-tabs .tab').forEach(x => x.classList.toggle('active', x===b));
    $('authBtn').textContent = authTab === 'login' ? '登录' : '注册';
    $('authErr').textContent = '';
  });
});

async function doAuthAction(){
  const u = $('authUser').value.trim();
  const p = $('authPass').value;
  $('authErr').textContent = '';
  try {
    const r = await api(authTab === 'login' ? '/api/login' : '/api/register', {
      method:'POST', body: JSON.stringify({u, p})
    });
    if (!r.ok) { $('authErr').textContent = r.msg || '操作失败'; return; }
    if (authTab === 'login') {
      authToken = r.token; authUser = r.user;
      localStorage.setItem('snakeToken', authToken);
      localStorage.setItem('snakeUser', authUser);
      enterLobby();
    } else {
      // 注册成功 → 自动登录
      const r2 = await api('/api/login', { method:'POST', body: JSON.stringify({u, p}) });
      if (r2.ok){
        authToken = r2.token; authUser = r2.user;
        localStorage.setItem('snakeToken', authToken);
        localStorage.setItem('snakeUser', authUser);
        enterLobby();
      } else {
        $('authErr').textContent = r2.msg || '注册后登录失败';
      }
    }
  } catch (e) { $('authErr').textContent = '网络错误'; }
}

$('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('snakeToken');
  localStorage.removeItem('snakeUser');
  authToken = null; authUser = null;
  ws && ws.close(); ws = null;
  showPanel('auth');
});

// 注销账号：密码确认后永久删除
$('deleteAcctBtn').addEventListener('click', async () => {
  if (!confirm('注销账号会永久删除账号和排行榜成绩，确定吗？')) return;
  const p = prompt('输入密码确认注销：');
  if (p === null) return;
  try {
    const r = await api('/api/delete-account', { method:'POST', body: JSON.stringify({ p }) });
    if (r.ok){
      alert('账号已注销，感谢游玩');
      localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
      authToken = null; authUser = null;
      ws && ws.close(); ws = null;
      showPanel('auth');
    } else {
      alert(r.msg || '注销失败');
    }
  } catch (e) { alert('网络错误，注销失败'); }
});

// —— 启动时自动恢复登录态 ——
(async function init(){
  await detectLocalServer();  // file:// 时先探测本机 server
  if (authToken) {
    const r = await api('/api/me');
    if (r.ok && r.user === authUser) enterLobby();
    else {
      localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
      authToken = null; authUser = null;
    }
  }
  if (!authToken) showPanel('auth');
})();

// ============================================================
//  WebSocket
// ============================================================
function defaultWsUrl(){
  if (WS_BASE_OVERRIDE) return WS_BASE_OVERRIDE;
  if (API_BASE === location.origin) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + location.host;
  }
  return FALLBACK_WS;  // Pages / file:// 走 Funnel
}
let ws = null;
let myRoom = null; // 当前加入的房间

function connectWs(){
  if (ws && ws.readyState < 2) return;
  ws = new WebSocket(defaultWsUrl());
  ws.onopen = () => { ws.send(JSON.stringify({t:'auth', token:authToken})); };
  ws.onclose = () => {
    // 断线 → 如果还在大厅/游戏面板，弹提示并重连
    if (currentPanel === 'lobby' || currentPanel === 'game'){
      showToast('连接断开，正在重连…');
      setTimeout(connectWs, 1500);
    }
  };
  ws.onmessage = ev => handleWs(JSON.parse(ev.data));
}

function handleWs(msg){
  switch (msg.t){
    case 'auth_ok': onAuthOk(msg.user); break;
    case 'auth_fail': onAuthFail(msg.msg); break;
    case 'need_auth': // WS 要求重认证
      localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
      authToken = null; authUser = null; showPanel('auth'); break;
    case 'rooms': renderRooms(msg.items); break;
    case 'room_created': onRoomCreated(msg); break;
    case 'joined_room': onJoinedRoom(msg); break;
    case 'room_full': showToast('房间已满'); break;
    case 'left_room': showPanel('lobby'); break;
    case 'chat': onChat(msg); break;
    case 'sys': showToast(msg.msg); break;
    // —— 游戏协议（加入房间后才处理）——
    case 'state': onState(msg); break;
    case 'pong': onPong(msg); break;
    case 'need_room': break;  // server 提示，忽略
    default: console.log('未知消息类型', msg.t);
  }
}

function onAuthOk(user){
  authUser = user;
  $('lobbyUserName').textContent = user;
  refreshMe(); refreshScores();
  showPanel('lobby');
  refreshRooms();
}
function onAuthFail(msg){
  showToast(msg);
  localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
  authToken = null; authUser = null; showPanel('auth');
}

async function refreshMe(){
  const r = await api('/api/me');
  if (r.ok) $('lobbyBest').textContent = '最高分 ' + (r.best||0);
}
async function refreshScores(){
  const r = await api('/api/scores');
  if (r.ok) renderLeaderboard(r.items);
}

function enterLobby(){ connectWs(); }

function sendWS(obj){ if (ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

// ============================================================
//  大厅：房间列表 / 创建 / 加入
// ============================================================
$('refreshRooms').addEventListener('click', refreshRooms);
function refreshRooms(){ sendWS({t:'list_rooms'}); }

function renderRooms(items){
  const el = $('roomList');
  if (!items.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px;text-align:center">暂无房间，创建一个吧！</div>'; return; }
  el.innerHTML = '';
  for (const r of items){
    const row = document.createElement('div');
    row.className = 'room-row' + (r.hasPwd ? ' locked' : '');
    row.innerHTML = `<div class="room-name">${escape(r.name)}${r.hasPwd ? '<span class="room-pass">🔒 有密码</span>' : ''}</div><div class="room-meta">房主 ${escape(r.owner)} · ${r.count}/${r.max} 人</div>`;
    row.addEventListener('click', () => joinRoom(r));
    el.appendChild(row);
  }
}

function joinRoom(room){
  if (room.hasPwd){
    const p = prompt('输入房间密码：');
    if (p === null) return;
    sendWS({t:'join_room', id:room.id, pass:p});
  } else {
    sendWS({t:'join_room', id:room.id});
  }
}

$('createRoomBtn').addEventListener('click', () => {
  const name = $('newRoomName').value.trim();
  const pass = $('newRoomPass').value.trim();
  if (!name) { showToast('请先填房间名'); return; }
  sendWS({t:'create_room', name, pass: pass || undefined});
  $('newRoomName').value = ''; $('newRoomPass').value = '';
});

function onRoomCreated(msg){ /* server 会自动 addPlayer → joined_room 消息 */ }

function onJoinedRoom(msg){
  myRoom = msg;
  wsPlayerId = msg.id;  // 关键：记录自己的玩家 ID，否则键盘监听不生效
  $('curRoomName').textContent = msg.roomName;
  $('enterRoomName').textContent = msg.roomName;
  $('menuError').textContent = '';
  $('menu').classList.remove('hidden');
  $('dead').classList.add('hidden');
  showPanel('game');
}

$('enterBtn').addEventListener('click', () => {
  $('menu').classList.add('hidden');
  updateHUD();
});

$('leaveBtn').addEventListener('click', () => {
  sendWS({t:'leave_room'});
  myRoom = null;
  showPanel('lobby');
});

// ============================================================
//  排行榜
// ============================================================
function renderLeaderboard(items){
  const el = $('rankList'); if (!el) return;
  el.innerHTML = '';
  items.forEach((p,i) => {
    const li = document.createElement('li');
    const me = p.u === authUser ? ' me' : '';
    li.className = me + ' top' + (i+1);
    li.innerHTML = `<span class="rk">${i+1}</span><span class="nm">${escape(p.u)}</span><span class="sc">${p.s}</span>`;
    el.appendChild(li);
  });
}

function escape(s){ return String(s).replace(/[<>]/g, c => ({'<':'<','>':'>'}[c])); }

// ============================================================
//  聊天（大厅 + 房间共用 renderChat）
// ============================================================
function appendChat(boxId, msg){
  const box = $(boxId); if (!box) return;
  const div = document.createElement('div');
  div.className = 'msg';
  let cls = 'from';
  let name = msg.from;
  if (msg.from === '系统') cls += ' sys';
  else if (msg.from === authUser) cls += ' me';
  div.innerHTML = `<span class="${cls}">${escape(name)}:</span>${escape(msg.text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function onChat(msg){
  // 在哪个面板就发哪个聊天框
  if (currentPanel === 'lobby') appendChat('lobbyChat', msg);
  else if (currentPanel === 'game') appendChat('roomChat', msg);
}

$('lobbyChatSend').addEventListener('click', () => {
  const input = $('lobbyChatInput');
  const text = input.value.trim(); if (!text) return;
  sendWS({t:'chat', text}); input.value = '';
});
$('lobbyChatInput').addEventListener('keydown', e => { if (e.key==='Enter') $('lobbyChatSend').click(); });
$('roomChatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const text = $('roomChatInput').value.trim(); if (!text) return;
    sendWS({t:'chat', text}); $('roomChatInput').value = '';
  }
});

// ============================================================
//  游戏状态（加入房间后）
// ============================================================
const CELL = 20;
let COLS=42, ROWS=30, TICK_MS=200;
let wsPlayerId = null;
let players = new Map(); // id → 玩家对象
let foods = [];
let curAt = 0;
let pingMs = 0, halfRtt = 0;
let inputSeq = 0, pendingTurns = [];
let deadShown = false;
let chosenMs = 200;

// —— 速度选择（登录菜单 + 游戏侧栏共享 chosenMs）——
document.querySelectorAll('#speedRow .speed-btn, #speedRow2 .speed-btn').forEach(b => {
  b.addEventListener('click', () => {
    const ms = Number(b.dataset.ms) || 200;
    chosenMs = ms;
    document.querySelectorAll('#speedRow .speed-btn, #speedRow2 .speed-btn').forEach(x =>
      x.classList.toggle('active', Number(x.dataset.ms)===ms)
    );
    if (currentPanel === 'game' && wsPlayerId) sendWS({t:'speed', ms});
  });
});

$('respawnBtn').addEventListener('click', () => { sendWS({t:'respawn'}); $('dead').classList.add('hidden'); });

// —— 输入：键盘 + 触摸（保留 server 给的 seq 机制）——
const KEYMAP = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
  w:'up', s:'down', a:'left', d:'right', W:'up', S:'down', A:'left', D:'right' };
function sendDir(dir){
  const me = players.get(wsPlayerId);
  if (!me || !me.alive) return;
  const last = pendingTurns.length ? pendingTurns[pendingTurns.length-1].dir : me.dir;
  if (dir === last) return;
  if (dir === {up:'down',down:'up',left:'right',right:'left'}[last]) return;
  pendingTurns.push({ seq: ++inputSeq, dir });
  if (pendingTurns.length > 2) pendingTurns.shift();
  sendWS({t:'dir', dir, seq:inputSeq});
}

window.addEventListener('keydown', e => {
  if (!wsPlayerId) return;
  if (e.key === ' ') { sendWS({t:'respawn'}); $('dead').classList.add('hidden'); e.preventDefault(); return; }
  if (e.key === 'Escape') { $('leaveBtn').click(); return; }
  const d = KEYMAP[e.key]; if (d) { sendDir(d); e.preventDefault(); }
});

// 每 2s ping 一次
setInterval(() => { if (ws && ws.readyState===1) ws.send(JSON.stringify({t:'ping', ts:Date.now()})); }, 2000);
function onPong(msg){ pingMs = Math.max(0, Date.now()-msg.ts); halfRtt = Math.min(250, pingMs/2); }

// ============================================================
//  渲染
// ============================================================
const canvas = $('game'); const ctx = canvas.getContext('2d');

function resizeCanvas(){
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(wrap.clientWidth * dpr);
  canvas.height = Math.round(wrap.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => { if (currentPanel==='game') resizeCanvas(); });

function onState(msg){
  if (msg.tickMs) TICK_MS = msg.tickMs;
  curAt = performance.now();
  // 更新玩家
  players.clear();
  for (const p of msg.players){
    players.set(p.id, { ...p });
    // 本地预测校正：清已确认的 seq
    if (p.id === wsPlayerId && p.seq !== undefined){
      pendingTurns = pendingTurns.filter(t => t.seq > p.seq);
      if (!p.alive) pendingTurns = [];
    }
  }
  foods = msg.foods;
  if (msg.tickMs) TICK_MS = msg.tickMs;
  render(); updateHUD(); updateMemberList();
}

function updateHUD(){
  const me = players.get(wsPlayerId);
  if (me){
    $('myScore').textContent = '得分 ' + me.score;
    if (!me.alive){
      if (!deadShown){
        deadShown = true;
        $('deadReason').textContent = me.deathReason || '';
        $('deadScore').textContent = me.score;
        $('dead').classList.remove('hidden');
      }
    } else { deadShown = false; $('dead').classList.add('hidden'); }
  }
  $('online').textContent = '在线 ' + players.size + ' 人';
  $('ping').textContent = '延迟 ' + Math.round(halfRtt*2) + 'ms';
}

function updateMemberList(){
  const el = $('memberList'); if (!el) return;
  el.innerHTML = '';
  for (const p of players.values()){
    const li = document.createElement('li');
    const me = p.id === wsPlayerId ? ' me' : '';
    li.className = me;
    li.innerHTML = `<div class="left"><span class="dot" style="background:${p.color}"></span><span class="nm">${escape(p.name)}${me ? ' (你)' : ''}</span></div><span>${p.score}</span>`;
    el.appendChild(li);
  }
}

// —— 渲染循环（和 snake-ext.js / mobile.js 一致：外推渲染）——
const DIRS = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };
function render(){
  if (currentPanel !== 'game') return;
  resizeCanvas();
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const cw = W / COLS, ch = H / ROWS;
  ctx.fillStyle = '#0a0e1c'; ctx.fillRect(0,0,W,H);
  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1;
  for (let x=0;x<=COLS;x++){ ctx.beginPath(); ctx.moveTo(x*cw,0); ctx.lineTo(x*cw,H); ctx.stroke(); }
  for (let y=0;y<=ROWS;y++){ ctx.beginPath(); ctx.moveTo(0,y*ch); ctx.lineTo(W,y*ch); ctx.stroke(); }
  // 食物
  ctx.fillStyle = '#ffd34d';
  for (const [x,y] of foods){ ctx.beginPath(); ctx.arc(x*cw+cw/2, y*ch+ch/2, cw*0.35, 0, Math.PI*2); ctx.fill(); }
  // 蛇（圆点风格：身体圆点 + 蛇头稍大 + 眼睛按朝向偏移）
  const now = performance.now();
  const frac = Math.min(1, Math.max(0, (now - curAt - Math.min(40, TICK_MS*0.25)) / TICK_MS));
  for (const p of players.values()){
    const color = p.alive ? p.color : 'rgba(107,114,128,.45)';
    // 本地预测：自己的蛇头朝 pendingTurns[0] 弯
    let bend = null;
    // 本地预测只在低延迟时启用，避免高延迟下服务器状态到达时回弹（蛇头抽搐）
    // halfRtt > 80ms 时关闭预测，直接信任服务器
    if (p.id === wsPlayerId && p.alive && pendingTurns.length && frac > 0 && halfRtt < 80){
      bend = pendingTurns[0].dir;
    }
    const cells = p.body;
    if (!cells || !cells.length) continue;
    // 外推位置
    const lerpSeg = (i) => {
      if (i === 0){
        const d = DIRS[bend || p.dir] || {x:0,y:0};
        return [cells[0][0] + d.x*frac, cells[0][1] + d.y*frac];
      }
      const prev = cells[i-1];
      return [cells[i][0] + (prev[0]-cells[i][0])*frac, cells[i][1] + (prev[1]-cells[i][1])*frac];
    };
    const cell = Math.min(cw, ch);
    // 蛇身圆点（从尾画到头，让头在上层）
    for (let i=cells.length-1; i>=0; i--){
      const g = lerpSeg(i);
      const x = g[0]*cw + cw/2, y = g[1]*ch + ch/2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, cell * (i===0 ? 0.46 : 0.4), 0, Math.PI*2);
      ctx.fill();
    }
    // 眼睛（按朝向偏移）
    if (p.alive){
      const h = lerpSeg(0);
      const hx = h[0]*cw + cw/2, hy = h[1]*ch + ch/2;
      const d = DIRS[bend || p.dir] || {x:0,y:0};
      const px = -d.y, py = d.x;             // 垂直于朝向
      const eo = cell*0.16, fo = cell*0.14;  // 左右间距 / 前向偏移
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(hx + d.x*fo + px*eo, hy + d.y*fo + py*eo, cell*0.09, 0, Math.PI*2);
      ctx.arc(hx + d.x*fo - px*eo, hy + d.y*fo - py*eo, cell*0.09, 0, Math.PI*2);
      ctx.fill();
    }
  }
  requestAnimationFrame(render);
}

function roundRect(c,x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath(); ctx.fill();
}

// —— toast ——
let toastTimer = null;
function showToast(msg){
  const t = $('toast');
  if (!t) { alert(msg); return; }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}
