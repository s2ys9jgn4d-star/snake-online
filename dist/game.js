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
const FALLBACK_WS = 'wss://snake-online.up.railway.app';
const FALLBACK_HTTP = 'https://snake-online.up.railway.app';
let API_BASE = FALLBACK_HTTP;  // 默认 Funnel，最稳
let WS_BASE_OVERRIDE = null;   // 探测到本机/同源服务器后覆盖

// 探测：同源是不是游戏服务器？本机有没有 server？都没有就保持 Funnel
async function detectLocalServer(){
  // 1. 同源探测（http/https 页面）
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

async function doAuthAction(){
  const u = $('authUser').value.trim();
  const p = $('authPass').value;
  const email = $('authEmail') ? $('authEmail').value.trim() : '';
  const code = $('authCode') ? $('authCode').value.trim() : '';
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
        $('authErr').textContent = r2.msg || t('regLoginFailed');
      }
    }
  } catch (e) { $('authErr').textContent = t('networkError'); }
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
  if (!confirm(t('confirmDelete'))) return;
  const p = prompt(t('promptPwd'));
  if (p === null) return;
  try {
    const r = await api('/api/delete-account', { method:'POST', body: JSON.stringify({ p }) });
    if (r.ok){
      alert(t('deleted'));
      localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
      authToken = null; authUser = null;
      ws && ws.close(); ws = null;
      showPanel('auth');
    } else {
      alert(r.msg || t('deleteFailed'));
    }
  } catch (e) { alert(t('deleteNet')); }
});

// —— 启动时自动恢复登录态 ——
(async function init(){
  await detectLocalServer();  // file:// 时先探测本机 server
  refreshMailReady();
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
      showToast(t('reconnecting'));
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
  $('lobbyChat').innerHTML = '';   // 每次进入大厅先清空，避免补发历史时重复
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
  if (r.ok){ myBest = r.best || 0; $('lobbyBest').textContent = t('best', { n: myBest }); }
}
async function refreshScores(){
  const r = await api('/api/scores');
  if (r.ok) renderLeaderboard(r.items);
}

// ============================================================
//  好友：申请 / 列表 / 私聊
// ============================================================
let friendCache = { friends: [], requests: [] };
let playerCache = [];
let dmWith = null;

function escHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

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
  // 待处理的好友申请
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
  // 我的好友
  const list = $('friendList');
  list.innerHTML = '';
  if (!friendCache.friends.length){
    list.innerHTML = '<div class="empty-tip">' + escHtml(t('noFriends')) + '</div>';
    return;
  }
  for (const f of friendCache.friends){
    const row = document.createElement('div');
    row.className = 'people-row';
    row.innerHTML = `<span class="dot${f.online ? ' on' : ''}"></span><span class="pn">${escHtml(f.u)}</span><span class="pb">${t('best', { n: f.best || 0 })}</span>`;
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
    row.innerHTML = `<span class="dot${p.online ? ' on' : ''}"></span><span class="pn">${escHtml(p.u)}</span><span class="pb">${t('best', { n: p.best || 0 })}</span>`;
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

// 在线状态变了：只改内存里的标记，然后重画
function onPresence(user, online){
  let changed = false;
  for (const f of friendCache.friends) if (f.u === user){ f.online = online; changed = true; }
  for (const p of playerCache) if (p.u === user){ p.online = online; changed = true; }
  if (changed){ renderFriends(); renderPlayers(); }
}

// —— 私聊小窗口 ——
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

function enterLobby(){ connectWs(); }

function sendWS(obj){ if (ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

// ============================================================
//  大厅：房间列表 / 创建 / 加入
// ============================================================
$('refreshRooms').addEventListener('click', refreshRooms);
function refreshRooms(){ sendWS({t:'list_rooms'}); }

function renderRooms(items){
  lastRooms = items; roomsLoaded = true;
  const el = $('roomList');
  if (!items.length){ el.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px;text-align:center">' + escHtml(t('noRooms')) + '</div>'; return; }
  el.innerHTML = '';
  for (const r of items){
    const row = document.createElement('div');
    row.className = 'room-row' + (r.hasPwd ? ' locked' : '');
    row.innerHTML = `<div class="room-name">${escape(r.name)}${r.hasPwd ? '<span class="room-pass">' + escHtml(t('roomPwdTag')) + '</span>' : ''}</div><div class="room-meta">${t('roomMeta', { name: escape(r.owner), n: r.count, max: r.max })}</div>`;
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
  lastRank = items || [];
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
let stateGap = 0;   // state 帧间隔滑动平均：帧抖时不再让蛇抽搐
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
  // 正在输入框里打字（用户名/密码/邮箱/聊天）时，不要抢方向键
  const el = e.target;
  const tag = (el && el.tagName) || '';
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (el && el.isContentEditable)) return;
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
  const _an = performance.now();
if (curAt) { const _dt = _an - curAt; if (_dt > 30 && _dt < 1200) stateGap = stateGap ? stateGap*0.82 + _dt*0.18 : _dt; }
curAt = _an;
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

function updateMemberList(){
  const el = $('memberList'); if (!el) return;
  el.innerHTML = '';
  for (const p of players.values()){
    const li = document.createElement('li');
    const me = p.id === wsPlayerId ? ' me' : '';
    li.className = me;
    li.innerHTML = `<div class="left"><span class="dot" style="background:${p.color}"></span><span class="nm">${escape(p.name)}${me ? escHtml(t('meSuffix')) : ''}</span></div><span>${p.score}</span>`;
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
  const _T = stateGap || TICK_MS;
const frac = Math.min(1.05, Math.max(0, (now - curAt - Math.min(40, _T*0.25)) / _T));
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
  const el = $('toast');
  if (!el) { alert(msg); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
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
  if ($('lobbyBest')) $('lobbyBest').textContent = t('best', { n: myBest });
  if (dmWith) $('dmTitle').textContent = '💬 ' + dmWith;
  if (roomsLoaded) renderRooms(lastRooms);
  if (!players.size){
    $('myScore').textContent = t('score', { n: 0 });
    $('online').textContent = t('online', { n: 0 });
    $('ping').textContent = t('pingDash');
  }
  if (lastRank.length) renderLeaderboard(lastRank);
  if (currentPanel === 'lobby'){ renderFriends(); renderPlayers(); }
  if (currentPanel === 'game' && wsPlayerId){ updateHUD(); updateMemberList(); }
}

window.addEventListener('snakelangchange', refreshI18nText);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshI18nText);
else refreshI18nText();
