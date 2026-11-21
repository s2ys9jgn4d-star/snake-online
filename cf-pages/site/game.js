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
  if (name === 'lobby') refreshMySkin();
}

// ============================================================
//  当前皮肤预览（大厅右栏）
// ============================================================
const SKIN_COLORS = {
  classic:{ c:['#22c55e'] },
  neon:{    c:['#a855f7'] },
  ice: {    c:['#38bdf8'] },
  lime:{    c:['#a3e635'] },
  gold:{    c:['#facc15'], glow:1 },
  rose:{    c:['#fb7185'], glow:1 },
  rainbow:{ c:['#f472b6','#facc15','#22d3ee','#a3e635','#a855f7'] },
  shadow:{  c:['#f8fafc'], glow:1 }
};
let mySkinId = 'classic';
function renderMySkin(id){
  mySkinId = id || 'classic';
  const box = $('mySkinDots'); const nameEl = $('mySkinName');
  if (!box) return;
  const sk = SKIN_COLORS[mySkinId] || SKIN_COLORS.classic;
  box.innerHTML = '';
  for (let i = 0; i < 6; i++){
    const d = document.createElement('i');
    const c = sk.c.length > 1 ? sk.c[i % sk.c.length] : sk.c[0];
    d.style.background = c;
    if (sk.glow) d.style.boxShadow = '0 0 8px ' + c;
    box.appendChild(d);
  }
  if (nameEl){
    const n = (typeof t === 'function') ? t('skin_' + mySkinId) : mySkinId;
    nameEl.textContent = (n && n.indexOf('skin_') !== 0) ? n : mySkinId;
  }
}
async function refreshMySkin(){
  let id = null;
  const cached = window.SNAKE_SHOP && window.SNAKE_SHOP.current();
  if (cached && cached.skin) id = cached.skin;
  if (!id){
    try { const d = await api('/api/shop'); if (d && d.ok) id = d.skin; } catch (e){}
  }
  renderMySkin(id || 'classic');
}
window.addEventListener('skinchanged', e => renderMySkin((e.detail && e.detail.skin) || 'classic'));
window.addEventListener('snakelangchange', () => renderMySkin(mySkinId));

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
  // 2. 本机 server：只在 http 页面（本地开发调试）才探测
  //    打包成客户端后是 file:// 页面，一律连线上，避免本机库和线上库两套账号打架
  if (location.protocol === 'http:') {
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
  const r = await fetch(API_BASE + path, { headers:h, credentials:'include', ...opts });
  return r.json();
}
// 皮肤商店（shop.js）复用同一套登录态与服务器地址
window.SNAKE = { api, token: () => authToken, user: () => authUser, isGuest: () => isGuestUser };

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
  $('agreeRow').classList.toggle('hidden', !reg);
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
      $('authErr').textContent = errMsg(r, t('sendFailed'));
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

// —— hCaptcha：登录/注册前的人机验证 ——
// Site Key 由服务端 /api/config 下发，没配置就不显示，也不拦
let hcEnabled = false, hcWidget = null, hcSiteKey = '';
// hCaptcha 不跟随页面语言，要把站内语言码转成它认识的写法
function hcLangCode(){
  const l = (window.getLang && window.getLang()) || 'en';
  const map = { 'zh-CN':'zh', 'zh-TW':'zh-tw', 'pt-PT':'pt', 'pt-BR':'pt' };
  return map[l] || String(l).split('-')[0];
}
function hcRender(){
  const box = $('hcaptchaBox');
  if (!box || !hcSiteKey || !window.hcaptcha) return;
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  try { if (hcWidget !== null && window.hcaptcha.reset) window.hcaptcha.reset(hcWidget); } catch (_) {}
  box.innerHTML = '';
  hcWidget = window.hcaptcha.render(box, {
    sitekey: hcSiteKey,
    theme: light ? 'light' : 'dark',
    hl: hcLangCode(),
    // 域名没加白、网络被挡时会让验证码报错，这时不要再拦登录
    'error-callback': function(){ hcEnabled = false; }
  });
}
async function setupHcaptcha(){
  try {
    const cfg = await api('/api/config');
    if (!cfg || !cfg.siteKey) return;
    if (!window.hcaptcha){
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://js.hcaptcha.com/1/api.js?render=explicit';
        s.async = true;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    if (!window.hcaptcha) return;
    hcSiteKey = cfg.siteKey;
    hcRender();
    hcEnabled = true;
    // 验证码是独立 iframe，切语言后要重新渲染才会跟着变
    window.addEventListener('snakelangchange', hcRender);
  } catch (_) { /* 脚本加载失败就不拦，服务端仍会校验 */ }
}

// 服务端错误提示：优先用返回的 key 翻译，翻不到再用中文原文
function errMsg(r, fallback){
  if (r && r.key){
    const s = t(r.key);
    if (s && s !== r.key) return s;
  }
  return (r && r.msg) || fallback || '';
}

// 官方账号第二步：弹出邮箱验证码输入框。确定返回字符串，取消返回 null。
function askOfficialCode(message, email){
  return new Promise(function(resolve){
    var tx = function(k, fb){ var s = (typeof t === 'function') ? t(k) : k; return (s && s !== k) ? s : fb; };
    var L = { title: tx('officialCodeTitle','Email code'),
              tip: tx('needOfficialCode','A 6-digit code was sent to the official mailbox.'),
              cancel: tx('cancel','Cancel'), ok: tx('ok','Confirm') };
    // 这个弹窗以前用了没定义的 en，官方登录一弹就抛 ReferenceError，
    // 被外层 catch 当成「网络错误」。语言判断统一在这里做。
    var isEn = (typeof getLang === 'function') && getLang() === 'en';
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px;';
    var card = document.createElement('div');
    card.style.cssText = 'box-sizing:border-box;width:100%;max-width:380px;background:#fff;border-radius:14px;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.22);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1d1d1f;';
    var title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px;';
    title.textContent = L.title;
    var tip = document.createElement('div');
    tip.style.cssText = 'font-size:13px;color:#6e6e73;margin-bottom:14px;';
    tip.textContent = message || L.tip;
    if (email){
      var to = document.createElement('div');
      to.style.cssText = 'font-size:12px;color:#86868b;margin:-8px 0 12px;';
      to.textContent = (isEn ? 'Sent to ' : '发到：') + email;
      card.appendChild(title); card.appendChild(tip); card.appendChild(to);
    } else {
      card.appendChild(title); card.appendChild(tip);
    }
    var input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.maxLength = 6;
    input.autocomplete = 'one-time-code';
    input.spellcheck = false;
    input.placeholder = isEn ? '6-digit code' : '6 位数字';
    input.style.cssText = 'box-sizing:border-box;width:100%;height:46px;padding:0 12px;border:1px solid #d2d2d7;border-radius:10px;font-size:22px;letter-spacing:6px;text-align:center;outline:none;';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:16px;';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = L.cancel;
    cancel.style.cssText = 'height:38px;padding:0 16px;border:1px solid #d2d2d7;background:#fff;color:#1d1d1f;border-radius:10px;font-size:14px;cursor:pointer;';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = L.ok;
    ok.style.cssText = 'height:38px;padding:0 18px;border:0;background:#0071e3;color:#fff;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;';
    row.appendChild(cancel); row.appendChild(ok);
    card.appendChild(input); card.appendChild(row);
    mask.appendChild(card);
    document.body.appendChild(mask);
    input.focus();
    function done(v){
      document.removeEventListener('keydown', onKey, true);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      resolve(v);
    }
    function onKey(e){
      if (e.key === 'Enter'){ e.preventDefault(); done(input.value.replace(/[^0-9]/g, '')); }
      else if (e.key === 'Escape'){ e.preventDefault(); done(null); }
    }
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', function(){ done(null); });
    ok.addEventListener('click', function(){ done(input.value.replace(/[^0-9]/g, '')); });
  });
}

async function doAuthAction(){
  const u = $('authUser').value.trim();
  const p = $('authPass').value;
  const email = $('authEmail') ? $('authEmail').value.trim() : '';
  const code = $('authCode') ? $('authCode').value.trim() : '';
  const captcha = $('captchaInput').value.trim();
  const hcToken = (hcEnabled && window.hcaptcha && hcWidget !== null) ? window.hcaptcha.getResponse(hcWidget) : '';
  $('authErr').textContent = '';
  // 不在这里硬拦：hCaptcha 在中国大陆常加载不出题目，服务端对空票据是放行的，
  // 只有带票据时才严格校验。客户端拦死会把所有人关在门外，所以票据为空也照常提交。
  if (authTab === 'register'){
    if (!email) { $('authErr').textContent = t('errEmailRequired'); return; }
    if (!EMAIL_RE.test(email)) { $('authErr').textContent = t('errEmailFormat'); return; }
    if (mailReady === true && !code) { $('authErr').textContent = t('errNeedCode'); return; }
    if (mailReady === false && !captcha){ $('authErr').textContent = t('errNeedCaptcha'); return; }
    if (!$('agreeBox').checked){ $('authErr').textContent = t('errAgree'); return; }
  }
  try {
    const r = await api(authTab === 'login' ? '/api/login' : '/api/register', {
      method:'POST', body: JSON.stringify(authTab === 'login' ? {u, p, hcaptcha: hcToken} : {u, p, email, code, cid: captchaId, captcha, hcaptcha: hcToken, agree: true})
    });
    // 官方账号：密码对了，服务端已往官方邮箱发验证码，这里弹窗让人填
    if (r && r.needOfficialCode){
      const c = await askOfficialCode(r.msg || '', r.email || '');
      if (c === null){ $('authErr').textContent = ''; return; }
      if (!c){ $('authErr').textContent = '请输入 6 位验证码'; return; }
      const ru = await api('/api/official/code', { method:'POST', body: JSON.stringify({ ticket: r.ticket, code: c }) });
      if (!ru.ok){ $('authErr').textContent = errMsg(ru, '验证码不对'); return; }
      authToken = ru.token; authUser = ru.user;
      localStorage.setItem('snakeToken', authToken);
      localStorage.setItem('snakeUser', authUser);
      enterLobby();
      return;
    }
    if (!r.ok){
      $('authErr').textContent = errMsg(r, t('opFailed'));
      if (window.hcaptcha && hcWidget !== null) window.hcaptcha.reset(hcWidget);
      if (authTab === 'register' && mailReady === false) refreshCaptcha();
      return;
    }
    if (authTab === 'login') {
      authToken = r.token; authUser = r.user;
      localStorage.setItem('snakeToken', authToken);
      localStorage.setItem('snakeUser', authUser);
      enterLobby();
    } else if (r.token) {
      // 注册接口直接带 token，省掉一次登录（hCaptcha 票据一次性）
      authToken = r.token; authUser = r.user;
      localStorage.setItem('snakeToken', authToken);
      localStorage.setItem('snakeUser', authUser);
      enterLobby();
    } else {
      // 老服务端注册后自动登录
      const r2 = await api('/api/login', { method:'POST', body: JSON.stringify({u, p, hcaptcha: hcToken}) });
      if (r2.ok){
        authToken = r2.token; authUser = r2.user;
        localStorage.setItem('snakeToken', authToken);
        localStorage.setItem('snakeUser', authUser);
        enterLobby();
      } else {
        $('authErr').textContent = errMsg(r2, t('regLoginFailed'));
      }
    }
  } catch (e) { $('authErr').textContent = t('networkError'); }
}

// —— 游客试玩：不注册、不保存，直接进大厅 ——
let isGuestUser = false;
$('guestBtn').addEventListener('click', async () => {
  $('authErr').textContent = '';
  try {
    const r = await api('/api/guest', { method:'POST' });
    if (!r.ok){ $('authErr').textContent = errMsg(r, t('opFailed')); return; }
    isGuestUser = true;
    authToken = r.token; authUser = r.user;
    localStorage.setItem('snakeToken', authToken);
    localStorage.setItem('snakeUser', authUser);
    enterLobby();
  } catch (e) { $('authErr').textContent = t('networkError'); }
});

// 游客界面：隐藏开房区、禁用大厅发言、显示限制说明
function applyGuestUI(){
  document.body.classList.toggle('is-guest', isGuestUser);
  const box = $('createRoomBox'); if (box) box.classList.toggle('hidden', isGuestUser);
  const tip = $('guestTip'); if (tip) tip.classList.toggle('hidden', !isGuestUser);
  const inp = $('lobbyChatInput'), btn = $('lobbyChatSend');
  if (inp) inp.disabled = isGuestUser;
  if (btn) btn.disabled = isGuestUser;
}

$('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('snakeToken');
  localStorage.removeItem('snakeUser');
  authToken = null; authUser = null;
  isGuestUser = false; applyGuestUI();
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

// —— 第三方快捷登录：Microsoft / Google / GitHub ——
// 哪些可用由服务端 /api/config 决定，没配 key 的按钮直接不显示
let oauthBase = '';
async function setupOauth(){
  try {
    const cfg = await api('/api/config');
    oauthBase = cfg.oauthBase || '';
    const row = $('oauthRow');
    if (!row) return;
    let any = false;
    row.querySelectorAll('[data-p]').forEach(btn => {
      const on = !!(cfg.oauth && cfg.oauth[btn.dataset.p]);
      btn.classList.toggle('hidden', !on);
      if (!on) return;
      any = true;
      btn.onclick = () => {
        location.href = oauthBase + '/api/oauth/' + btn.dataset.p + '/start?return=' +
          encodeURIComponent(location.origin + location.pathname);
      };
    });
    if (any) row.classList.remove('hidden');
  } catch (_) {}
}
// 第三方登录回来会带 ?oauthCode=xxx，用它换真正的登录态
async function handleOauthReturn(){
  const q = new URLSearchParams(location.search);
  const code = q.get('oauthCode');
  const err = q.get('oauth');
  if (!code && !err) return false;
  history.replaceState(null, '', location.pathname);
  if (code){
    try {
      const r = await api('/api/oauth/exchange', { method:'POST', body: JSON.stringify({ code }) });
      if (r && r.ok && r.token){
        authToken = r.token; authUser = r.user; isGuestUser = false;
        localStorage.setItem('snakeToken', authToken);
        localStorage.setItem('snakeUser', authUser);
        enterLobby();
        return true;
      }
    } catch (_) {}
    showPanel('auth');
    const e = $('authErr'); if (e) e.textContent = t('oauthFail');
  } else {
    showPanel('auth');
    const e = $('authErr');
    if (e) e.textContent = (err === 'banned') ? t('bannedMsg') : t('oauthFail');
  }
  return false;
}



// —— 启动时自动恢复登录态 ——
(async function init(){
  await detectLocalServer();  // file:// 时先探测本机 server
  if (await handleOauthReturn()) return;
  refreshMailReady();
  if (authToken) {
    const r = await api('/api/me');
    if (r.ok && r.user === authUser){ isGuestUser = !!r.guest; enterLobby(); }
    else {
      localStorage.removeItem('snakeToken'); localStorage.removeItem('snakeUser');
      authToken = null; authUser = null;
    }
  }
  // 浏览器里登录态存在 httpOnly Cookie 里，页面读不到，只能问一次服务器
  if (!authToken) {
    const c = await api('/api/me');
    if (c.ok && c.user){
      // 只有 Cookie 没有 token：先换一个 token，WebSocket 和商店都要用它
      const t = await api('/api/token', { method:'POST', body:'{}' });
      if (t && t.ok && t.token){
        authToken = t.token; authUser = t.user || c.user;
        localStorage.setItem('snakeToken', authToken);
        localStorage.setItem('snakeUser', authUser);
      } else {
        console.warn('Cookie 换 token 失败：' + ((t && t.msg) || '未知原因'));
      }
      isGuestUser = !!c.guest;
      enterLobby();
      return;
    }
  }
  if (!authToken) {
    // 先显示登录面板再渲染 hCaptcha，避免在隐藏容器里渲染尺寸异常
    showPanel('auth');
    setupHcaptcha();
    setupOauth();
  }
})();

// —— Cookie 提示条：只问一次，选择记在本地 ——
(function(){
  function setupCookieBar(){
    const bar = document.getElementById('cookieBar');
    if (!bar) return;
    if (localStorage.getItem('snakeCookieNotice') === '1'){ bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const setT = (sel, key) => {
      const el = sel.charAt(0) === '#' ? document.getElementById(sel.slice(1)) : document.querySelector(sel);
      if (el && typeof t === 'function') el.textContent = t(key);
    };
    setT('#cookieBar .cookie-text', 'cookie_notice');
    setT('#cookieBar .cookie-more', 'cookie_more');
    setT('#cookieAccept', 'cookie_accept');
    const btn = document.getElementById('cookieAccept');
    if (btn) btn.addEventListener('click', () => {
      localStorage.setItem('snakeCookieNotice', '1');
      bar.classList.add('hidden');
    });
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', setupCookieBar);
  else setupCookieBar();
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
    case 'sys': showToast(msg.key ? t(msg.key, msg.args) : msg.msg); break;
    // —— 好友实时事件 ——
    case 'friend_request': showToast(t('friendWants', { name: msg.from })); refreshFriends(); refreshPlayers(); break;
    case 'friend_accept': showToast(t('nowFriends', { name: msg.by })); refreshFriends(); refreshPlayers(); break;
    case 'friend_msg':
      if (dmWith === msg.from && !$('dmBox').classList.contains('hidden')) appendDm(msg);
      else showToast(t('friendMsg', { name: msg.from, text: msg.text }));
      break;
    case 'friend_recall': markDmRecall(msg.mid); break;
    case 'presence': onPresence(msg.user, msg.online); break;
    // —— 游戏协议（加入房间后才处理）——
    case 'state': onState(msg); break;
    case 'pong': onPong(msg); break;
    case 'need_room': break;  // server 提示，忽略
    default:
      // 群组事件交给 groups.js 处理
      if (window.Groups && String(msg.t||'').indexOf('group_') === 0) Groups.onEvent(msg);
      else console.log('未知消息类型', msg.t);
  }
}

function onAuthOk(user){
  authUser = user;
  $('lobbyUserName').textContent = isGuestUser ? user + ' · ' + t('guestTag') : user;
  applyGuestUI();
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
  if (r.ok){
    myBest = r.best || 0; $('lobbyBest').textContent = t('best', { n: fmtNum(myBest) });
    // 官方账号不可注销，直接把按钮藏掉
    if (r.official){ const b = $('deleteAcctBtn'); if (b) b.style.display = 'none'; }
  }
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

// 名字 + 官方徽章（off 由服务器标记）；名字单独包一层，超长时只省略名字，徽章不被裁掉
function nameHtml(u, off){
  return '<span class="nm-t">' + escHtml(u) + '</span>' + (off ? '<span class="off-badge">' + escHtml(t('offBadge')) + '</span>' : '');
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
  box.appendChild(dmNode(m));
  box.scrollTop = box.scrollHeight;
}
function richT(k, fallback){ return window.RichText ? RichText.T(k) : fallback; }
function dmNode(m){
  const mine = m.from === authUser;
  const div = document.createElement('div');
  div.className = 'msg dm' + (mine ? ' mine' : '');
  if (m.id) div.setAttribute('data-mid', m.id);
  if (m.recalled){
    div.classList.add('recalled');
    div.textContent = (mine ? '' : m.from + ' ') + richT('recalled', '撤回了一条消息');
    return div;
  }
  const from = document.createElement('span');
  from.className = 'from';
  from.textContent = (mine ? t('me') : m.from) + ':';
  div.appendChild(from);
  const body = document.createElement('span');
  body.className = 'txt';
  div.appendChild(body);
  if (window.RichText) RichText.mount(body, m.text);
  else body.textContent = m.text;
  if (mine && m.id){
    const rc = document.createElement('button');
    rc.type = 'button';
    rc.className = 'dm-recall';
    rc.textContent = richT('recall', '撤回');
    rc.onclick = () => recallDm(m, div);
    div.appendChild(rc);
  }
  return div;
}
async function recallDm(m, node){
  if (!dmWith || !m || !m.id) return;
  const r = await api('/api/friend/recall', { method:'POST', body: JSON.stringify({ to: dmWith, mid: m.id }) });
  if (!r.ok) return showToast(r.msg || t('opFailed'));
  m.recalled = true; m.text = '';
  if (node && node.parentNode) node.parentNode.replaceChild(dmNode(m), node);
}
function markDmRecall(mid){
  const box = $('dmMsgs'); if (!box || !mid) return;
  const node = box.querySelector('[data-mid="' + mid + '"]');
  if (!node) return;
  node.classList.add('recalled');
  node.textContent = richT('recalled', '撤回了一条消息');
}
async function sendDm(){
  const input = $('dmInput');
  const text = input.value.trim();
  if (!text || !dmWith) return;
  input.value = '';
  const r = await api('/api/friend/chat', { method:'POST', body: JSON.stringify({ to: dmWith, text }) });
  if (!r.ok){ showToast(r.msg || t('sendFailed')); input.value = text; return; }
  appendDm(r.item || { from: authUser, text });
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
// 深链接 #solo：自动开一局单人模式并进入（演示 / 截图用）
if (location.hash === '#solo'){
  setTimeout(() => { try { soloBtnEl && soloBtnEl.click(); } catch(_){} }, 1200);
  let tries = 0;
  const t = setInterval(() => {
    const m = document.getElementById('menu');
    const b = document.getElementById('enterBtn');
    if (b && m && !m.classList.contains('hidden')) { b.click(); }
    if (++tries > 12) clearInterval(t);
  }, 500);
}

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
  const roomLabel = msg.solo ? t('soloRoomName', { name: msg.soloOf || authUser }) : msg.roomName;
  $('curRoomName').textContent = roomLabel;
  $('enterRoomName').textContent = roomLabel;
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
    li.innerHTML = `<span class="rk">${i+1}</span><span class="nm">${nameHtml(p.u, p.off)}</span><span class="sc">${fmtNum(p.s)}</span>`;
    el.appendChild(li);
  });
}

function escape(s){ return escHtml(s); }

// ============================================================
//  聊天（大厅 + 房间共用 renderChat）
// ============================================================
function appendChat(boxId, msg){
  const box = $(boxId); if (!box) return;
  const div = document.createElement('div');
  div.className = 'msg';
  let cls = 'from';
  // 系统消息：服务端只发 key + 参数，这里按当前语言翻译
  const isSys = !!msg.sys || msg.from === '系统';
  const name = isSys ? t('sysLabel') : msg.from;
  const body = msg.key ? t(msg.key, msg.args) : msg.text;
  if (isSys) cls += ' sys';
  else if (msg.from === authUser) cls += ' me';
  const nameEl = document.createElement('span');
  nameEl.className = cls;
  nameEl.textContent = name + ':';
  div.appendChild(nameEl);
  const bodyEl = document.createElement('span');
  bodyEl.className = 'txt';
  div.appendChild(bodyEl);
  // 系统文案和纯文本模式直接写文本；开了 Markdown/LaTeX 才走渲染
  if (isSys || !window.RichText) bodyEl.textContent = body;
  else RichText.mount(bodyEl, body);
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
// —— 设置：默认速度 / 主题 / 改名（存在本机，换设备不跟着走）——
function loadSettings(){
  try { return JSON.parse(localStorage.getItem('snakeSettings') || '{}') || {}; } catch { return {}; }
}
function saveSettings(patch){
  const s = Object.assign(loadSettings(), patch);
  localStorage.setItem('snakeSettings', JSON.stringify(s));
  return s;
}
const userSettings = loadSettings();
if (userSettings.theme === 'light') document.documentElement.setAttribute('data-theme','light');

let chosenMs = Number(userSettings.speed) || 200;
// 按保存的默认速度点亮对应的按钮
document.querySelectorAll('#speedRow .speed-btn, #speedRow2 .speed-btn').forEach(x =>
  x.classList.toggle('active', Number(x.dataset.ms) === chosenMs)
);

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

// —— 设置面板：默认速度 / 界面主题 / 账号改名 ——
const setModal = $('settingsModal');
function openSettings(){
  const s = loadSettings();
  const cur = Number(s.speed) || chosenMs;
  document.querySelectorAll('#setSpeeds .speed-btn').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.ms) === cur));
  const theme = s.theme === 'light' ? 'light' : 'dark';
  document.querySelectorAll('#setThemes .theme-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === theme));
  $('setNameInput').value = authUser || '';
  // 聊天增强：标签按当前语言显示，按钮状态跟本地保存的一致
  if (window.RichText){
    const rl = $('richLabel'); if (rl) rl.textContent = RichText.T('rich');
    const rh = $('richHint'); if (rh) rh.textContent = RichText.T('richHint');
  }
  syncRichBtns();
  const tip = $('setNameTip');
  tip.className = 'set-tip';
  tip.textContent = t('nameTip');
  // 游客没有邮箱，整块重置密码都不显示
  const pg = $('passGroup');
  if (pg) pg.classList.toggle('hidden', isGuestUser);
  const rt = $('resetTip');
  if (rt){ rt.className = 'set-tip'; rt.textContent = ''; }
  setModal.classList.remove('hidden');
}
$('settingsBtn').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', () => setModal.classList.add('hidden'));
setModal.addEventListener('click', e => { if (e.target === setModal) setModal.classList.add('hidden'); });

document.querySelectorAll('#setSpeeds .speed-btn').forEach(b => {
  b.addEventListener('click', () => {
    const ms = Number(b.dataset.ms) || 200;
    saveSettings({ speed: ms });
    document.querySelectorAll('#setSpeeds .speed-btn').forEach(x =>
      x.classList.toggle('active', Number(x.dataset.ms) === ms));
    // 立刻同步到游戏内速度选择，不用等下次进房间
    chosenMs = ms;
    document.querySelectorAll('#speedRow .speed-btn, #speedRow2 .speed-btn').forEach(x =>
      x.classList.toggle('active', Number(x.dataset.ms) === ms));
    if (currentPanel === 'game' && wsPlayerId) sendWS({ t:'speed', ms });
  });
});

document.querySelectorAll('#setThemes .theme-btn').forEach(b => {
  b.addEventListener('click', () => {
    const mode = b.dataset.theme === 'light' ? 'light' : 'dark';
    saveSettings({ theme: mode });
    if (mode === 'light') document.documentElement.setAttribute('data-theme','light');
    else document.documentElement.removeAttribute('data-theme');
    document.querySelectorAll('#setThemes .theme-btn').forEach(x =>
      x.classList.toggle('active', x.dataset.theme === mode));
  });
});

// —— 聊天增强开关：Markdown / LaTeX，两种互不影响，都存本机 ——
function syncRichBtns(){
  const st = window.RichText ? RichText.get() : { md:false, tex:false };
  document.querySelectorAll('#setRich .rich-btn').forEach(b => {
    b.classList.toggle('active', !!st[b.dataset.rich]);
  });
}
document.querySelectorAll('#setRich .rich-btn').forEach(b => {
  b.addEventListener('click', () => {
    if (!window.RichText) return;
    const k = b.dataset.rich;
    const cur = RichText.get();
    RichText.set(k, !cur[k]);
    syncRichBtns();
    if (k === 'tex' && RichText.get().tex) showToast(t('loading'));
  });
});
syncRichBtns();

// 换语言后：聊天增强的标签、界面上动态生成的列表都要跟着换
window.addEventListener('snakelangchange', () => {
  if (window.RichText){
    const rl = $('richLabel'); if (rl) rl.textContent = RichText.T('rich');
    const rh = $('richHint'); if (rh) rh.textContent = RichText.T('richHint');
  }
  syncRichBtns();
  try {
    if (currentPanel === 'lobby'){ refreshRooms(); refreshFriends(); refreshPlayers(); refreshScores(); }
    else if (currentPanel === 'game'){ refreshFriends && refreshFriends(); }
  } catch (e){}
});

const mySkinChange = $('mySkinChange');
if (mySkinChange) mySkinChange.addEventListener('click', ev => {
  ev.preventDefault();
  if (window.SNAKE_SHOP) window.SNAKE_SHOP.open();
  else { const b = $('shopBtn'); if (b) b.click(); }
});

$('setNameBtn').addEventListener('click', async () => {
  const nu = $('setNameInput').value.trim();
  const tip = $('setNameTip');
  tip.className = 'set-tip';
  if (!nu){ tip.textContent = t('nameEmpty'); tip.classList.add('err'); return; }
  if (nu === authUser){ tip.textContent = t('nameSame'); tip.classList.add('err'); return; }
  tip.textContent = t('saving');
  try {
    const r = await fetch('/api/rename', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + authToken },
      body: JSON.stringify({ name: nu })
    }).then(x => x.json());
    if (!r.ok){ tip.textContent = r.msg || '改名失败'; tip.classList.add('err'); return; }
    localStorage.setItem('snakeUser', r.user);
    tip.textContent = t('nameOk');
    tip.classList.add('ok');
    setTimeout(() => location.reload(), 700);
  } catch {
    tip.textContent = t('netErr');
    tip.classList.add('err');
  }
});

$('respawnBtn').addEventListener('click', () => { sendWS({t:'respawn'}); $('dead').classList.add('hidden'); });

// —— 邮箱验证码重置密码 ——
let resetTimer = null;
$('resetSendBtn').addEventListener('click', async () => {
  const btn = $('resetSendBtn'), tip = $('resetTip');
  btn.disabled = true;
  tip.className = 'set-tip';
  tip.textContent = t('saving');
  try {
    const r = await fetch('/api/reset_code', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + authToken },
      body: '{}'
    }).then(x => x.json());
    if (!r.ok){ tip.className='set-tip err'; tip.textContent = r.msg || t('resetFail'); btn.disabled = false; return; }
    tip.className = 'set-tip ok';
    tip.textContent = r.msg || t('resetSent');
    let left = 60;
    btn.textContent = left + 's';
    clearInterval(resetTimer);
    resetTimer = setInterval(() => {
      left--;
      if (left <= 0){
        clearInterval(resetTimer); resetTimer = null;
        btn.disabled = false; btn.textContent = t('resetSend');
      } else btn.textContent = left + 's';
    }, 1000);
  } catch {
    tip.className = 'set-tip err';
    tip.textContent = t('netErr');
    btn.disabled = false;
  }
});
$('resetPassBtn').addEventListener('click', async () => {
  const tip = $('resetTip');
  const code = $('resetCode').value.trim();
  const pass = $('resetPass').value;
  tip.className = 'set-tip';
  if (!code){ tip.className='set-tip err'; tip.textContent = t('errNeedCode'); return; }
  if (pass.length < 4 || pass.length > 32){ tip.className='set-tip err'; tip.textContent = t('errPassLen'); return; }
  try {
    const r = await fetch('/api/reset_pass', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + authToken },
      body: JSON.stringify({ code, pass })
    }).then(x => x.json());
    if (!r.ok){ tip.className='set-tip err'; tip.textContent = r.msg || t('resetFail'); return; }
    tip.className = 'set-tip ok';
    tip.textContent = r.msg || t('resetOk');
    $('resetCode').value = '';
    $('resetPass').value = '';
  } catch {
    tip.className = 'set-tip err';
    tip.textContent = t('netErr');
  }
});

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
        $('deadReason').textContent = me.deathReason ? t(me.deathReason) : '';
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
    const skinId = p.skin || 'classic';
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
    // 光晕皮肤（黄金 / 玫瑰 / 墨影）
    if (p.alive && (skinId==='gold' || skinId==='rose' || skinId==='shadow')){
      ctx.shadowBlur = cell * 0.9;
      ctx.shadowColor = color;
    }
    // 蛇身圆点（从尾画到头，让头在上层）
    for (let i=cells.length-1; i>=0; i--){
      const g = lerpSeg(i);
      const x = g[0]*cw + cw/2, y = g[1]*ch + ch/2;
      ctx.fillStyle = (p.alive && skinId==='rainbow')
        ? 'hsl(' + ((i*22 + Math.floor(now/90)) % 360) + ',92%,64%)'
        : color;
      ctx.beginPath();
      ctx.arc(x, y, cell * (i===0 ? 0.46 : 0.4), 0, Math.PI*2);
      ctx.fill();
    }
    // 眼睛（按朝向偏移）
    ctx.shadowBlur = 0;
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
  if (currentPanel === 'game' && wsPlayerId){ updateHUD(); updateMemberList(); }
}

window.addEventListener('snakelangchange', refreshI18nText);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshI18nText);
else refreshI18nText();
