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
const FALLBACK_WS = 'wss://snake-online.up.railway.app';
const FALLBACK_HTTP = 'https://snake-online.up.railway.app';
let API_BASE = FALLBACK_HTTP;
let WS_BASE_OVERRIDE = null;

// 探测：同源是不是游戏服务器？本机有没有 server？都没有就保持 Funnel
async function detectLocalServer(){
  if (/^https?:$/.test(location.protocol)) {
    try {
      const r = await fetch(location.origin + '/api/scores', { signal: AbortSignal.timeout(1500) });
      // 必须真的是游戏服务器回的 JSON 才算数：静态托管对未知路径可能回 200 + 首页 HTML
      if (r.ok && (r.headers.get('content-type') || '').includes('json')){
        const d = await r.json();
        if (d && d.ok === true){ API_BASE = location.origin; return; }
      }
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
    $('authBtn').textContent = authTab === 'login' ? t('login') : t('register');
    $('authErr').textContent = '';
    applyRegExtra();
    $('authPass').autocomplete = authTab === 'login' ? 'current-password' : 'new-password';
    if (authTab === 'register') refreshMailReady();
  });
});

// 邮箱发信是否可用：不可用时注册就改成图片验证码
let mailReady = null;
// 邮箱格式：和服务器一致，用户名@域名.后缀，比如 abc@example.com
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
let captchaId = '';
function applyRegExtra(){
  const reg = authTab === 'register';
  // 邮箱一直是必填（用于封号追溯）；验证码行只在邮件服务真的可用时才出现
  $('regExtra').classList.toggle('hidden', !reg);
  $('mailCodeBox').classList.toggle('hidden', !(reg && mailReady === true));
  $('captchaBox').classList.toggle('hidden', !(reg && mailReady === false));
  $('noMailTip').classList.toggle('hidden', !(reg && mailReady === false));
}
async function refreshMailReady(){
  try {
    const r = await api('/api/mail-status');
    mailReady = !!(r && r.ok && r.configured);
  } catch (e) { mailReady = null; }
  applyRegExtra();
  if (mailReady === false) refreshCaptcha();
}
async function refreshCaptcha(){
  try {
    const r = await api('/api/captcha');
    if (!r || !r.ok) return;
    captchaId = r.id;
    $('captchaImg').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.svg);
    $('captchaInput').value = '';
  } catch (e) {}
}
$('captchaRefresh').addEventListener('click', refreshCaptcha);
$('captchaImg').addEventListener('click', refreshCaptcha);

// —— 注册：发送邮箱验证码（60 秒内不能重发）——
let codeLeft = 0, codeTimer = null;
$('sendCodeBtn').addEventListener('click', async () => {
  if (codeLeft > 0) return;
  const email = $('authEmail').value.trim();
  const u = $('authUser').value.trim();
  const btn = $('sendCodeBtn');
  if (!email) { $('authErr').textContent = t('errEmail'); return; }
  if (!EMAIL_RE.test(email)) { $('authErr').textContent = t('errEmailFormat'); return; }
  $('authErr').textContent = '';
  $('codeTip').textContent = '';
  btn.disabled = true; btn.textContent = t('sending');
  try {
    const r = await api('/api/send-code', { method:'POST', body: JSON.stringify({ email, u }) });
    if (!r.ok){
      $('authErr').textContent = r.msg || t('sendFailed');
      btn.disabled = false; btn.textContent = t('sendCode');
      refreshMailReady();   // 发不出去就切到「免验证码注册」
      return;
    }
    $('codeTip').textContent = t('codeSent', { email });
    codeLeft = 60;
    btn.textContent = t('seconds', { n: codeLeft });
    clearInterval(codeTimer);
    codeTimer = setInterval(() => {
      codeLeft--;
      if (codeLeft <= 0){
        clearInterval(codeTimer);
        btn.disabled = false; btn.textContent = t('resend');
      } else btn.textContent = t('seconds', { n: codeLeft });
    }, 1000);
  } catch (e){
    $('authErr').textContent = t('errCodeNet');
    btn.disabled = false; btn.textContent = t('sendCode');
  }
});

async function doAuth(){
  const u = $('authUser').value.trim();
  const p = $('authPass').value;
  const email = $('authEmail').value.trim();
  const code = $('authCode').value.trim();
  const captcha = $('captchaInput').value.trim();
  $('authErr').textContent = '';
  if (authTab === 'register'){
    if (!email) { $('authErr').textContent = t('errEmailRequired'); return; }
    if (!EMAIL_RE.test(email)) { $('authErr').textContent = t('errEmailFormat'); return; }
    if (mailReady === true && !code) { $('authErr').textContent = t('errNeedCode'); return; }
    if (mailReady === false && !captcha){ $('authErr').textContent = t('errNeedCaptcha'); return; }
  }
  try {
    const r = await api(authTab === 'login' ? '/api/login' : '/api/register', {
      method:'POST', body: JSON.stringify(authTab === 'login' ? {u, p} : {u, p, email, code, cid: captchaId, captcha})
    });
    if (!r.ok){
      $('authErr').textContent = r.msg || t('opFailed');
      if (authTab === 'register' && mailReady === false) refreshCaptcha();
      return;
    }
    if (authTab === 'login') {
      saveAuth(r);
    } else {
      const r2 = await api('/api/login', { method:'POST', body: JSON.stringify({u, p}) });
      if (r2.ok) saveAuth(r2); else $('authErr').textContent = r2.msg || t('regLoginFailed');
    }
  } catch (e) { $('authErr').textContent = t('networkError'); }
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
  if (!confirm(t('confirmDelete'))) return;
  const p = prompt(t('promptPwd'));
  if (p === null) return;
  try {
    const r = await api('/api/delete-account', { method:'POST', body: JSON.stringify({ p }) });
    if (r.ok){
      alert(t('deleted'));
      localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
      authToken = null; authUser = null;
      if (ws) ws.close(); ws = null;
      showPanel('auth');
    } else {
      alert(r.msg || t('deleteFailed'));
    }
  } catch (e) { alert(t('deleteNet')); }
});

(async function init(){
  await detectLocalServer();  // file:// 时先探测本机 server
  refreshMailReady();
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
      showToast(t('reconnecting'));
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
    case 'room_full': showToast(t('roomFull')); break;
    case 'left_room': showPanel('lobby'); break;
    case 'chat': onChat(msg); break;
    case 'sys': showToast(msg.msg); break;
    // —— 好友实时事件 ——
    case 'friend_request': showToast(t('friendWants', { name: msg.from })); refreshFriends(); refreshPlayers(); break;
    case 'friend_accept': showToast(t('nowFriends', { name: msg.by })); refreshFriends(); refreshPlayers(); break;
    case 'friend_msg':
      if (dmWith === msg.from && !$('dmBox').classList.contains('hidden')) appendDm(msg);
      else showToast(t('friendMsg', { name: msg.from, text: msg.text }));
      break;
    case 'presence': onPresence(msg.user, msg.online); break;
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
  refreshFriends(); refreshPlayers();
  startSocialPoll();
  showPanel('lobby');
  refreshRooms();
}

// 好友/玩家面板定时刷新：WS 推送可能因为断线或页面在后台而错过，靠轮询兜底
let socialTimer = null;
function startSocialPoll(){
  if (socialTimer) return;
  socialTimer = setInterval(() => {
    if (currentPanel !== 'lobby') return;   // 只在看大厅时刷新，不打扰游戏
    refreshFriends(); refreshPlayers();
  }, 8000);
}
function onAuthFail(msg){
  showToast(msg);
  localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
  authToken = null; authUser = null; showPanel('auth');
}

async function refreshMe(){
  const r = await api('/api/me');
  if (r.ok){ myBest = r.best || 0; $('lobbyBest').textContent = t('best', { n: fmtNum(myBest) }); }
}
async function refreshScores(){
  const r = await api('/api/scores');
  if (r.ok) renderLeaderboard(r.items);
}
function enterLobby(){ connectWs(); }

// ============================================================
//  好友：申请 / 列表 / 私聊
// ============================================================
let friendCache = { friends: [], requests: [] };
let playerCache = [];
let dmWith = null;

function escHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 名字 + 官方徽章（off 由服务器标记）；名字单独包一层，超长时只省略名字，徽章不被裁掉
function nameHtml(u, off){
  return '<span class="nm-t">' + escHtml(u) + '</span>' + (off ? '<span class="off-badge">✓ 官方</span>' : '');
}
// 大数字加千分位：10000000000 → 10,000,000,000
function fmtNum(n){ return Number(n || 0).toLocaleString('en-US'); }

async function refreshFriends(){
  const r = await api('/api/friends');
  if (!r.ok) return;
  friendCache = { friends: r.friends || [], requests: r.requests || [] };
  renderFriends();
}
async function refreshPlayers(){
  const r = await api('/api/players');
  if (!r.ok) return;
  playerCache = r.items || [];
  renderPlayers();
}

function renderFriends(){
  const reqBox = $('friendReqBox');
  reqBox.innerHTML = '';
  for (const q of friendCache.requests){
    const row = document.createElement('div');
    row.className = 'req-row';
    row.innerHTML = `<span>${t('friendWants', { name: '<b>' + escHtml(q.from) + '</b>' })}</span>`;
    const okBtn = document.createElement('button');
    okBtn.className = 'mini-btn'; okBtn.textContent = t('accept');
    okBtn.onclick = async () => {
      await api('/api/friend/accept', { method:'POST', body: JSON.stringify({ from:q.from }) });
      refreshFriends(); refreshPlayers();
    };
    const noBtn = document.createElement('button');
    noBtn.className = 'mini-btn ghost'; noBtn.textContent = t('reject');
    noBtn.onclick = async () => {
      await api('/api/friend/reject', { method:'POST', body: JSON.stringify({ from:q.from }) });
      refreshFriends();
    };
    row.appendChild(okBtn); row.appendChild(noBtn);
    reqBox.appendChild(row);
  }
  const list = $('friendList');
  list.innerHTML = '';
  if (!friendCache.friends.length){
    list.innerHTML = '<div class="empty-tip">' + escHtml(t('noFriends')) + '</div>';
    return;
  }
  for (const f of friendCache.friends){
    const row = document.createElement('div');
    row.className = 'people-row';
    row.innerHTML = `<span class="dot${f.online ? ' on' : ''}"></span><span class="pn">${nameHtml(f.u, f.off)}</span><span class="pb">${t('best', { n: fmtNum(f.best) })}</span>`;
    const chatBtn = document.createElement('button');
    chatBtn.className = 'mini-btn'; chatBtn.textContent = t('chat');
    chatBtn.onclick = () => openDm(f.u);
    row.appendChild(chatBtn);
    list.appendChild(row);
  }
}

function renderPlayers(){
  const q = ($('playerSearch').value || '').trim().toLowerCase();
  const list = $('playerList');
  list.innerHTML = '';
  const items = playerCache.filter(p => !q || p.u.toLowerCase().includes(q));
  if (!items.length){
    list.innerHTML = '<div class="empty-tip">' + escHtml(playerCache.length ? t('noSearch') : t('noPlayers')) + '</div>';
    return;
  }
  for (const p of items.slice(0, 100)){
    const row = document.createElement('div');
    row.className = 'people-row';
    row.innerHTML = `<span class="dot${p.online ? ' on' : ''}"></span><span class="pn">${nameHtml(p.u, p.off)}</span><span class="pb">${t('best', { n: fmtNum(p.best) })}</span>`;
    const btn = document.createElement('button');
    btn.className = 'mini-btn';
    if (p.relation === 'friend'){
      btn.textContent = t('chat'); btn.onclick = () => openDm(p.u);
    } else if (p.relation === 'outgoing'){
      btn.textContent = t('requested'); btn.disabled = true;
    } else if (p.relation === 'incoming'){
      btn.textContent = t('accept');
      btn.onclick = async () => {
        await api('/api/friend/accept', { method:'POST', body: JSON.stringify({ from:p.u }) });
        refreshFriends(); refreshPlayers();
      };
    } else {
      btn.textContent = t('addFriend');
      btn.onclick = async () => {
        const r = await api('/api/friend/request', { method:'POST', body: JSON.stringify({ to:p.u }) });
        showToast(r.msg || (r.ok ? t('reqSent') : t('reqFail')));
        refreshPlayers(); refreshFriends();
      };
    }
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function onPresence(user, online){
  let changed = false;
  for (const f of friendCache.friends) if (f.u === user){ f.online = online; changed = true; }
  for (const p of playerCache) if (p.u === user){ p.online = online; changed = true; }
  if (changed){ renderFriends(); renderPlayers(); }
}

// —— 私聊（手机上是底部抽屉）——
function openDm(user){
  dmWith = user;
  $('dmTitle').textContent = '💬 ' + user;
  $('dmMsgs').innerHTML = '<div class="empty-tip">' + escHtml(t('loading')) + '</div>';
  $('dmBox').classList.remove('hidden');
  $('dmInput').value = '';
  setTimeout(() => $('dmInput').focus(), 50);
  api('/api/friend/history', { method:'POST', body: JSON.stringify({ with:user }) }).then(r => {
    if (dmWith !== user) return;
    $('dmMsgs').innerHTML = '';
    if (!r.ok){ $('dmMsgs').innerHTML = '<div class="empty-tip">' + escHtml(r.msg || t('loadFail')) + '</div>'; return; }
    if (!r.items.length) $('dmMsgs').innerHTML = '<div class="empty-tip">' + escHtml(t('noHistory')) + '</div>';
    else for (const m of r.items) appendDm(m);
  });
}
function appendDm(m){
  const box = $('dmMsgs');
  if (box.querySelector('.empty-tip')) box.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'msg dm' + (m.from === authUser ? ' mine' : '');
  div.innerHTML = `<span class="from">${escHtml(m.from === authUser ? t('me') : m.from)}:</span>${escHtml(m.text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
async function sendDm(){
  const input = $('dmInput');
  const text = input.value.trim();
  if (!text || !dmWith) return;
  input.value = '';
  const r = await api('/api/friend/chat', { method:'POST', body: JSON.stringify({ to: dmWith, text }) });
  if (!r.ok){ showToast(r.msg || t('sendFailed')); input.value = text; return; }
  appendDm({ from: authUser, text });
}
$('dmSend').addEventListener('click', sendDm);
$('dmInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendDm(); });
$('dmClose').addEventListener('click', () => { $('dmBox').classList.add('hidden'); dmWith = null; });
$('playerSearch').addEventListener('input', renderPlayers);

// ============================================================
//  大厅：房间列表 / 创建 / 加入
// ============================================================
$('refreshRooms').addEventListener('click', refreshRooms);
function refreshRooms(){ sendWS({t:'list_rooms'}); }

function renderRooms(items){
  lastRooms = items; roomsLoaded = true;
  const el = $('roomList');
  if (!items.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px;text-align:center">' + escHtml(t('noRooms')) + '</div>'; return; }
  el.innerHTML = '';
  for (const r of items){
    const row = document.createElement('div');
    row.className = 'room-row';
    row.innerHTML = `<div><div class="room-name">${esc(r.name)}${r.hasPwd ? '<span class="room-pass"> ' + escHtml(t('roomPwdTag')) + '</span>' : ''}</div><div class="room-meta">${t('roomMeta', { name: esc(r.owner), n: r.count, max: r.max })}</div></div>`;
    row.addEventListener('click', () => joinRoom(r));
    el.appendChild(row);
  }
}

function joinRoom(room){
  if (room.hasPwd){
    const p = prompt(t('roomPwdPrompt'));
    if (p === null) return;
    sendWS({t:'join_room', id:room.id, pass:p});
  } else {
    sendWS({t:'join_room', id:room.id});
  }
}

// 单人模式：服务器会开一间私密房并塞进一个豆包
const soloBtnEl = $('soloBtn');
if (soloBtnEl) soloBtnEl.addEventListener('click', () => sendWS({ t:'solo' }));

$('createRoomBtn').addEventListener('click', () => {
  const name = $('newRoomName').value.trim();
  const pass = $('newRoomPass').value.trim();
  if (!name) { showToast(t('needRoomName')); return; }
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
  lastRank = items || [];
  const el = $('rankList'); if (!el) return;
  el.innerHTML = '';
  items.forEach((p,i) => {
    const li = document.createElement('li');
    if (p.u === authUser) li.classList.add('me');
    li.classList.add('top' + (i+1));
    li.innerHTML = `<span class="rk">${i+1}</span><span class="nm">${nameHtml(p.u, p.off)}</span><span class="sc">${fmtNum(p.s)}</span>`;
    el.appendChild(li);
  });
}

function esc(s){ return escHtml(s); }

function onChat(msg){
  // 手机版只显示 toast（避免遮挡游戏画面）；历史记录不弹，否则一进来就刷屏
  if (msg.history) return;
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
let stateGap = 0;   // state 帧间隔滑动平均：帧抖时不再让蛇抽搐
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

// —— 发送转向 ——
// 注意：手机版之前漏了这个函数，方向键一点就抛 ReferenceError，看起来像"按键没反应"
const OPPOSITE_DIR = { up:'down', down:'up', left:'right', right:'left' };
function sendDir(dir){
  const me = players.get(wsPlayerId);
  if (!me || !me.alive) return;
  const last = pendingTurns.length ? pendingTurns[pendingTurns.length-1].dir : me.dir;
  if (dir === last || dir === OPPOSITE_DIR[last]) return;
  pendingTurns.push({ seq: ++inputSeq, dir });
  if (pendingTurns.length > 2) pendingTurns.shift();
  sendWS({ t:'dir', dir, seq: inputSeq });
}

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
// 绑在整个游戏区（#stage）而不是只绑 canvas：手指落在画布外的留白上也能滑
let touchStart = null;
const canvasEl = $('game');
const swipeArea = $('stage');
swipeArea.addEventListener('touchstart', e => {
  if (e.target.closest('button')) { touchStart = null; return; }
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });

swipeArea.addEventListener('touchmove', e => {
  if (!touchStart) return;
  const t = e.touches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
  sendDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });

// 手指抬起后重置起点，否则下一滑会从上次的落点开始算，方向会错
swipeArea.addEventListener('touchend', () => { touchStart = null; }, { passive: true });
swipeArea.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });

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
    showToast(t('noLandscape'));
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
  const _an = performance.now();
if (curAt) { const _dt = _an - curAt; if (_dt > 30 && _dt < 1200) stateGap = stateGap ? stateGap*0.82 + _dt*0.18 : _dt; }
curAt = _an;
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
    $('myScore').textContent = t('score', { n: me.score });
    if (!me.alive){
      if (!deadShown){
        deadShown = true;
        $('deadReason').textContent = me.deathReason || '';
        $('deadScore').textContent = me.score;
        $('dead').classList.remove('hidden');
      }
    } else { deadShown = false; $('dead').classList.add('hidden'); }
  }
  $('online').textContent = t('online', { n: players.size });
  $('ping').textContent = t('ping', { n: Math.round(halfRtt*2) });
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
  const _T = stateGap || TICK_MS;
const frac = Math.min(1.05, Math.max(0, (now - curAt - Math.min(40, _T*0.25)) / _T));
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
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2200);
}

// ============================================================
//  多语言：静态标注由 applyI18n 处理，这里补动态文案
// ============================================================
let myBest = 0, lastRooms = [], lastRank = [], roomsLoaded = false;

function refreshI18nText(){
  if (window.applyI18n) applyI18n(document);
  const cap = $('captchaImg'); if (cap) cap.alt = t('captchaAlt');
  const authBtn = $('authBtn'); if (authBtn) authBtn.textContent = authTab === 'login' ? t('login') : t('register');
  const codeBtn = $('sendCodeBtn');
  if (codeBtn && !codeBtn.disabled && codeLeft <= 0) codeBtn.textContent = t('sendCode');
  if ($('lobbyBest')) $('lobbyBest').textContent = t('best', { n: fmtNum(myBest) });
  if (dmWith) $('dmTitle').textContent = '💬 ' + dmWith;
  if (roomsLoaded) renderRooms(lastRooms);
  if (!players.size){
    $('myScore').textContent = t('score', { n: 0 });
    $('online').textContent = t('online', { n: 0 });
    $('ping').textContent = t('pingDash');
  }
  if (lastRank.length) renderLeaderboard(lastRank);
  if (currentPanel === 'lobby'){ renderFriends(); renderPlayers(); }
  if (currentPanel === 'game' && wsPlayerId) updateHUD();
}

window.addEventListener('snakelangchange', refreshI18nText);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshI18nText);
else refreshI18nText();
