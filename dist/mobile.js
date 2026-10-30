'use strict';
/*
 * 多人联机贪吃蛇 —— 手机版完整客户端
 * 三面板：auth → lobby → game
 * 输入：虚拟十字键 + 屏幕滑动
 */

// ============================================================
//  面板切换
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
//  HTTP API
// ============================================================
// API 地址推导：与 WebSocket 同源逻辑
// - 同源（Mac 直接访问 / 局域网）：用 location.origin
// - 本机 server：file:// 或非 https 页面探测 localhost:8180
// - 其他（如 Cloudflare Pages）：用 Funnel 公网地址
const FALLBACK_WS = 'wss://niesdemacbook-air.tail4f9990.ts.net';
const FALLBACK_HTTP = 'https://niesdemacbook-air.tail4f9990.ts.net';
let API_BASE = FALLBACK_HTTP;
let WS_BASE_OVERRIDE = null;

// 探测：同源是不是游戏服务器？本机有没有 server？都没有就保持 Funnel
async function detectLocalServer(){
  if (/^https?:$/.test(location.protocol)) {
    try {
      const r = await fetch(location.origin + '/api/scores', { signal: AbortSignal.timeout(800) });
      if (r.ok){ API_BASE = location.origin; return; }
    } catch {}
  }
  if (location.protocol !== 'https:') {
    try {
      const r = await fetch('http://localhost:8180/api/scores', { signal: AbortSignal.timeout(800) });
      if (r.ok){
        API_BASE = 'http://localhost:8180';
        WS_BASE_OVERRIDE = 'ws://localhost:8180';
        return;
      }
    } catch {}
  }
}
let authToken = localStorage.getItem('snakeToken') || null;
let authUser = localStorage.getItem('snakeUser') || null;

async function api(path, opts={}){
  const h = {'Content-Type':'application/json'};
  if (authToken) h.Authorization = 'Bearer ' + authToken;
  const r = await fetch(API_BASE + path, { headers:h, ...opts });
  return r.json();
}

let authTab = 'login';
$('authBtn').addEventListener('click', doAuth);
$('authPass').addEventListener('keydown', e => { if (e.key==='Enter') doAuth(); });
document.querySelectorAll('.auth-tabs .tab').forEach(b => {
  b.addEventListener('click', () => {
    authTab = b.dataset.tab;
    document.querySelectorAll('.auth-tabs .tab').forEach(x => x.classList.toggle('active', x===b));
    $('authBtn').textContent = authTab === 'login' ? '登录' : '注册';
    $('authErr').textContent = '';
  });
});

async function doAuth(){
  const u = $('authUser').value.trim();
  const p = $('authPass').value;
  $('authErr').textContent = '';
  try {
    const r = await api(authTab === 'login' ? '/api/login' : '/api/register', {
      method:'POST', body: JSON.stringify({u, p})
    });
    if (!r.ok) { $('authErr').textContent = r.msg || '操作失败'; return; }
    if (authTab === 'login') {
      saveAuth(r);
    } else {
      const r2 = await api('/api/login', { method:'POST', body: JSON.stringify({u, p}) });
      if (r2.ok) saveAuth(r2); else $('authErr').textContent = r2.msg || '注册后登录失败';
    }
  } catch (e) { $('authErr').textContent = '网络错误'; }
}

function saveAuth(r){
  authToken = r.token; authUser = r.user;
  localStorage.setItem('snakeToken', authToken);
  localStorage.setItem('snakeUser', authUser);
  enterLobby();
}

$('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
  authToken = null; authUser = null;
  if (ws) ws.close(); ws = null;
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
      if (ws) ws.close(); ws = null;
      showPanel('auth');
    } else {
      alert(r.msg || '注销失败');
    }
  } catch (e) { alert('网络错误，注销失败'); }
});

(async function init(){
  await detectLocalServer();  // file:// 时先探测本机 server
  if (authToken){
    const r = await api('/api/me');
    if (r.ok && r.user === authUser){ enterLobby(); return; }
    localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
    authToken = null; authUser = null;
  }
  showPanel('auth');
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
  return FALLBACK_WS;
}
let ws = null;

function connectWs(){
  if (ws && ws.readyState < 2) return;
  ws = new WebSocket(defaultWsUrl());
  ws.onopen = () => ws.send(JSON.stringify({t:'auth', token:authToken}));
  ws.onclose = () => {
    if (currentPanel === 'lobby' || currentPanel === 'game'){
      showToast('连接断开，正在重连…');
      setTimeout(connectWs, 1500);
    }
  };
  ws.onmessage = ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleWs(msg);
  };
}

function handleWs(msg){
  switch (msg.t){
    case 'auth_ok': onAuthOk(msg.user); break;
    case 'auth_fail': onAuthFail(msg.msg); break;
    case 'need_auth':
      localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
      authToken = null; authUser = null; showPanel('auth'); break;
    case 'rooms': renderRooms(msg.items); break;
    case 'room_created': /* 自动 joined_room */ break;
    case 'joined_room': onJoinedRoom(msg); break;
    case 'room_full': showToast('房间已满'); break;
    case 'left_room': showPanel('lobby'); break;
    case 'chat': onChat(msg); break;
    case 'sys': showToast(msg.msg); break;
    case 'state': onState(msg); break;
    case 'pong': onPong(msg); break;
    case 'need_room': break;  // server 提示，忽略
  }
}

function sendWS(obj){ if (ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

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

// ============================================================
//  大厅：房间列表 / 创建 / 加入
// ============================================================
$('refreshRooms').addEventListener('click', refreshRooms);
function refreshRooms(){ sendWS({t:'list_rooms'}); }

function renderRooms(items){
  const el = $('roomList');
  if (!items.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px;text-align:center">暂无房间，创建一个吧！</div>'; return; }
  el.innerHTML = '';
  for (const r of items){
    const row = document.createElement('div');
    row.className = 'room-row';
    row.innerHTML = `<div><div class="room-name">${esc(r.name)}${r.hasPwd ? '<span class="room-pass"> 🔒</span>' : ''}</div><div class="room-meta">房主 ${esc(r.owner)} · ${r.count}/${r.max} 人</div></div>`;
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

function onJoinedRoom(msg){
  wsPlayerId = msg.id;  // 关键：记录自己的玩家 ID
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

// ============================================================
//  排行榜
// ============================================================
function renderLeaderboard(items){
  const el = $('rankList'); if (!el) return;
  el.innerHTML = '';
  items.forEach((p,i) => {
    const li = document.createElement('li');
    if (p.u === authUser) li.classList.add('me');
    li.classList.add('top' + (i+1));
    li.innerHTML = `<span class="rk">${i+1}</span><span class="nm">${esc(p.u)}</span><span class="sc">${p.s}</span>`;
    el.appendChild(li);
  });
}

function esc(s){ return String(s).replace(/[<>]/g, c => ({'<':'<','>':'>'}[c])); }

function onChat(msg){
  // 手机版只显示 toast（避免遮挡游戏画面）
  showToast(msg.from + ': ' + msg.text);
}

// ============================================================
//  游戏状态
// ============================================================
const CELL = 20;
let COLS=42, ROWS=30, TICK_MS=200;
let wsPlayerId = null;
let players = new Map();
let foods = [];
let curAt = 0;
let halfRtt = 0;
let inputSeq = 0, pendingTurns = [];
let deadShown = false;
let chosenMs = 200;

// 速度选择
document.querySelectorAll('#speedRow .speed-btn').forEach(b => {
  b.addEventListener('click', () => {
    chosenMs = Number(b.dataset.ms) || 200;
    document.querySelectorAll('#speedRow .speed-btn').forEach(x =>
      x.classList.toggle('active', Number(x.dataset.ms)===chosenMs)
    );
  });
});

$('respawnBtn').addEventListener('click', () => { sendWS({t:'respawn'}); $('dead').classList.add('hidden'); });

// —— 输入：虚拟十字键 ——
document.querySelectorAll('.vbtn').forEach(btn => {
  const fire = e => {
    e.preventDefault();
    if (wsPlayerId) sendDir(btn.dataset.dir);
  };
  btn.addEventListener('touchstart', fire, { passive: false });
  btn.addEventListener('mousedown', fire);
});

// —— 输入：屏幕滑动 ——
let touchStart = null;
const canvasEl = $('game');
canvasEl.addEventListener('touchstart', e => {
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });

canvasEl.addEventListener('touchmove', e => {
  if (!touchStart) return;
  const t = e.touches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
  sendDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });

// 死亡层点击重生
$('dead').addEventListener('touchstart', () => {
  if (wsPlayerId) { sendWS({t:'respawn'}); $('dead').classList.add('hidden'); }
}, { passive: true });

// —— 全屏横屏 ——
$('fsBtn').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch (e) {
    showToast('不支持自动横屏，请手动旋转手机');
  }
});

// ping
setInterval(() => { if (ws && ws.readyState===1) ws.send(JSON.stringify({t:'ping', ts:Date.now()})); }, 2000);
function onPong(msg){ halfRtt = Math.min(250, Math.max(0, Date.now()-msg.ts)/2); }

// ============================================================
//  渲染
// ============================================================
const ctx = canvasEl.getContext('2d');

function resizeCanvas(){
  const stage = $('stage');
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth, h = stage.clientHeight;
  // 保持 42:30 比例
  const scale = Math.min(w/840, h/600);
  canvasEl.style.width = Math.round(840*scale) + 'px';
  canvasEl.style.height = Math.round(600*scale) + 'px';
  canvasEl.width = Math.round(840*scale*dpr);
  canvasEl.height = Math.round(600*scale*dpr);
  ctx.setTransform(dpr*scale, 0, 0, dpr*scale, 0, 0);
}
window.addEventListener('resize', () => { if (currentPanel==='game') resizeCanvas(); });

function onState(msg){
  if (msg.tickMs) TICK_MS = msg.tickMs;
  curAt = performance.now();
  players.clear();
  for (const p of msg.players){
    players.set(p.id, { ...p });
    if (p.id === wsPlayerId && p.seq !== undefined){
      pendingTurns = pendingTurns.filter(t => t.seq > p.seq);
      if (!p.alive) pendingTurns = [];
    }
  }
  foods = msg.foods;
  if (msg.tickMs) TICK_MS = msg.tickMs;
  render(); updateHUD();
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

const DIRS_MAP = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };

function render(){
  if (currentPanel !== 'game') return;
  resizeCanvas();
  const cw = 840/COLS, ch = 600/ROWS;
  ctx.fillStyle = '#0a0e1c'; ctx.fillRect(0,0,840,600);
  ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1;
  for (let x=0;x<=COLS;x++){ ctx.beginPath(); ctx.moveTo(x*cw,0); ctx.lineTo(x*cw,600); ctx.stroke(); }
  for (let y=0;y<=ROWS;y++){ ctx.beginPath(); ctx.moveTo(0,y*ch); ctx.lineTo(840,y*ch); ctx.stroke(); }
  ctx.fillStyle = '#ffd34d';
  for (const [x,y] of foods){ ctx.beginPath(); ctx.arc(x*cw+cw/2, y*ch+ch/2, cw*0.35, 0, Math.PI*2); ctx.fill(); }
  const now = performance.now();
  const frac = Math.min(1, Math.max(0, (now - curAt - Math.min(40, TICK_MS*0.25)) / TICK_MS));
  const cell = Math.min(cw, ch);
  for (const p of players.values()){
    const color = p.alive ? p.color : 'rgba(107,114,128,.45)';
    let bend = null;
    // 本地预测只在低延迟时启用，避免高延迟下回弹
    if (p.id === wsPlayerId && p.alive && pendingTurns.length && frac > 0 && halfRtt < 80) bend = pendingTurns[0].dir;
    const cells = p.body;
    if (!cells || !cells.length) continue;
    const lerpSeg = (i) => {
      if (i === 0){
        const d = DIRS_MAP[bend || p.dir] || {x:0,y:0};
        return [cells[0][0] + d.x*frac, cells[0][1] + d.y*frac];
      }
      const prev = cells[i-1];
      return [cells[i][0] + (prev[0]-cells[i][0])*frac, cells[i][1] + (prev[1]-cells[i][1])*frac];
    };
    for (let i=cells.length-1; i>=0; i--){
      const g = lerpSeg(i);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(g[0]*cw + cw/2, g[1]*ch + ch/2, cell * (i===0 ? 0.46 : 0.4), 0, Math.PI*2);
      ctx.fill();
    }
    if (p.alive){
      const h = lerpSeg(0);
      const hx = h[0]*cw + cw/2, hy = h[1]*ch + ch/2;
      const d = DIRS_MAP[bend || p.dir] || {x:0,y:0};
      const px = -d.y, py = d.x;
      const eo = cell*0.16, fo = cell*0.14;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(hx + d.x*fo + px*eo, hy + d.y*fo + py*eo, cell*0.09, 0, Math.PI*2);
      ctx.arc(hx + d.x*fo - px*eo, hy + d.y*fo - py*eo, cell*0.09, 0, Math.PI*2);
      ctx.fill();
    }
  }
  requestAnimationFrame(render);
}

function roundRect(x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath(); ctx.fill();
}

function showToast(msg){
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2200);
}
