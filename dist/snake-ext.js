/*
 * 联机贪吃蛇 —— TurboWarp / Scratch 自定义扩展（单积木版 · 完整账号版）
 *
 * 用法：TurboWarp → 添加扩展 → 自定义扩展 → 输入
 *   http://localhost:8180/snake-ext.js
 *   ★ 必须勾选「在沙盒外运行」
 *
 * 积木参数：用户名 + 密码 + 服务器地址
 * 启动时自动注册/登录 → 自动创建或加入房间 → 直接开战
 */
(function (Scratch) {
  'use strict';

  const DEFAULT_URL = 'ws://localhost:8180';
  // API_BASE 由 WS URL 推导：ws→http, wss→https
  let API_BASE = DEFAULT_URL.replace(/^ws/, 'http');

  let overlay = null;
  let authToken = null;
  let authUser = null;
  let myRoomId = null;

  // ---------- HTTP API ----------
  async function api(path, body){
    const h = {'Content-Type':'application/json'};
    if (authToken) h.Authorization = 'Bearer ' + authToken;
    const r = await fetch(API_BASE + path, { method:'POST', headers:h, body: JSON.stringify(body) });
    return r.json();
  }

  async function ensureAuth(user, pass){
    // 先尝试登录；失败则注册后再登录
    let r = await api('/api/login', { u: user, p: pass });
    if (r.ok) return r;
    r = await api('/api/register', { u: user, p: pass });
    if (!r.ok) return { ok:false, msg: r.msg || '注册失败' };
    r = await api('/api/login', { u: user, p: pass });
    return r;
  }

  // ---------- 游戏覆盖层 ----------
  function launch(user, pass, speed, url) {
    if (overlay) return;
    // 从 WS URL 推导 API base（ws→http, wss→https）
    API_BASE = String(url || DEFAULT_URL).replace(/^ws/, 'http');

    const root = document.createElement('div');
    root.style.cssText =
      'position:fixed;inset:0;z-index:999999;background:#0f172a;' +
      'font-family:system-ui,-apple-system,"PingFang SC",sans-serif;';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    const board = document.createElement('div');
    board.style.cssText =
      'position:absolute;top:14px;right:14px;min-width:150px;padding:10px 14px;' +
      'background:rgba(15,23,42,.82);border:1px solid #334155;border-radius:10px;' +
      'color:#e2e8f0;font-size:14px;line-height:1.7;white-space:pre;';
    const chatBox = document.createElement('div');
    chatBox.style.cssText =
      'position:absolute;left:14px;bottom:40px;max-width:280px;max-height:120px;overflow-y:auto;' +
      'background:rgba(15,23,42,.82);border:1px solid #334155;border-radius:10px;' +
      'color:#e2e8f0;font-size:13px;line-height:1.6;padding:8px 12px;display:none;';
    const hint = document.createElement('div');
    hint.textContent = '方向键/WASD 移动 · 空格重生 · Esc 退出 · T 聊天';
    hint.style.cssText =
      'position:absolute;left:0;right:0;bottom:10px;text-align:center;' +
      'color:#64748b;font-size:13px;pointer-events:none;';
    root.appendChild(canvas);
    root.appendChild(board);
    root.appendChild(chatBox);
    root.appendChild(hint);
    document.body.appendChild(root);
    overlay = root;

    const ctx = canvas.getContext('2d');
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(root.clientWidth * dpr);
      canvas.height = Math.round(root.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    // ---------- 网络 ----------
    let myId = 0, cols = 42, rows = 30, tickMs = 200;
    let cur = null;
    let pingMs = 0, pingTimer = 0;
    let disconnected = false;
    let started = false;
    let ws = null;
    let pendingTurns = [];
    let halfRtt = 0;
    let inputSeq = 0;
    let chatVisible = false;

    function showChat() { chatBox.style.display = 'block'; chatBox.scrollTop = chatBox.scrollHeight; }
    function hideChat() { chatBox.style.display = 'none'; }

    function addChatMsg(from, text){
      const div = document.createElement('div');
      div.innerHTML = `<span style="color:${from==='系统'?'#fbbf24':from===user?'#34d399':'#5b8cff'};font-weight:600">${from}:</span> ${escapeHtml(text)}`;
      chatBox.appendChild(div);
      chatBox.scrollTop = chatBox.scrollHeight;
      showChat();
      clearTimeout(chatBox._hideTimer);
      chatBox._hideTimer = setTimeout(hideChat, 5000);
    }

    function escapeHtml(s){ return String(s).replace(/[<>]/g, c => ({'<':'<','>':'>'}[c])); }

    async function connect(){
      // 先确保已登录
      if (!authToken){
        const r = await ensureAuth(user, pass);
        if (!r.ok){
          disconnected = true;
          drawMsg('登录失败：' + (r.msg || '未知错误'), '#f87171');
          return;
        }
        authToken = r.token; authUser = r.user;
      }

      try { ws = new WebSocket(url); } catch (e) { disconnected = true; return; }
      ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: authToken }));
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
      }, 2000);
      ws.onclose = () => { disconnected = true; };
      ws.onerror = () => { disconnected = true; };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.t === 'auth_ok'){
          // 认证成功 → 自动创建房间（如果还没进房间）
          if (!myRoomId) sendWS({ t: 'create_room', name: user + '的房间' });
        } else if (msg.t === 'room_created'){
          myRoomId = msg.id;
          // server 会自动 addPlayer → joined_room
        } else if (msg.t === 'joined_room'){
          myId = msg.id; cols = msg.cols; rows = msg.rows; tickMs = msg.tickMs || 200;
          started = true;
          sendWS({ t: 'speed', ms: speed });
        } else if (msg.t === 'state'){
          if (msg.tickMs) tickMs = msg.tickMs;
          cur = { time: performance.now(), data: msg };
          const meAck = msg.players.find(p => p.id === myId);
          if (meAck && meAck.seq) pendingTurns = pendingTurns.filter(t => t.seq > meAck.seq);
          if (!meAck || !meAck.alive) pendingTurns = [];
          renderBoard();
        } else if (msg.t === 'pong'){
          pingMs = Math.max(0, Date.now() - msg.ts);
          halfRtt = Math.min(250, pingMs / 2);
          renderBoard();
        } else if (msg.t === 'chat'){
          addChatMsg(msg.from, msg.text);
        } else if (msg.t === 'sys'){
          addChatMsg('系统', msg.msg);
        }
      };
      frame();
    }

    function sendWS(obj){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

    // ---------- 键盘 ----------
    const KEYMAP = {
      ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
      w:'up', s:'down', a:'left', d:'right', W:'up', S:'down', A:'left', D:'right'
    };
    function sendDir(dir){
      const me = cur && cur.data.players.find(p => p.id === myId);
      if (!me || !me.alive) return;
      const last = pendingTurns.length ? pendingTurns[pendingTurns.length-1].dir : me.dir;
      if (dir === last) return;
      if (dir === { up:'down', down:'up', left:'right', right:'left' }[last]) return;
      pendingTurns.push({ seq: ++inputSeq, dir });
      if (pendingTurns.length > 2) pendingTurns.shift();
      sendWS({ t:'dir', dir, seq: inputSeq });
    }

    let chatInput = null;
    function openChatInput(){
      if (chatInput) return;
      chatInput = document.createElement('input');
      chatInput.maxLength = 200;
      chatInput.placeholder = '输入聊天内容，Enter 发送，Esc 取消';
      chatInput.style.cssText =
        'position:absolute;left:14px;bottom:40px;width:280px;padding:8px 12px;' +
        'border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;' +
        'font-size:14px;outline:none;z-index:10;';
      root.appendChild(chatInput);
      chatInput.focus();
      chatInput.addEventListener('keydown', e => {
        if (e.key === 'Enter'){
          const text = chatInput.value.trim();
          if (text) sendWS({ t:'chat', text });
          chatInput.remove(); chatInput = null;
        } else if (e.key === 'Escape'){
          chatInput.remove(); chatInput = null;
        }
      });
    }

    function onKey(e){
      if (e.key === 'Escape'){ quit(); return; }
      if (!started) return;
      if (e.key === ' '){ sendWS({ t:'respawn' }); e.preventDefault(); return; }
      if (e.key === 't' || e.key === 'T'){ openChatInput(); e.preventDefault(); return; }
      const dir = KEYMAP[e.key];
      if (dir){ sendDir(dir); e.preventDefault(); }
    }
    window.addEventListener('keydown', onKey, true);

    // ---------- 排行榜 ----------
    function renderBoard(){
      if (!cur) return;
      const ps = cur.data.players.slice().sort((a,b) => b.score - a.score);
      let html = '延迟 ' + pingMs + 'ms\n房间 ' + (myRoomId || '-') + '\n排行榜\n';
      ps.forEach((p,i) => {
        const me = p.id === myId ? ' ◄' : '';
        html += `${i+1}. ${p.name} ${p.score}${p.alive ? '' : ' ✕'}${me}\n`;
      });
      board.textContent = html;
    }

    // ---------- 渲染循环 ----------
    let raf = 0;
    function frame(){
      if (!overlay) return;
      render();
      raf = requestAnimationFrame(frame);
    }

    const DIRS = { up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0} };

    function render(){
      if (!cur) return;
      const W = root.clientWidth, H = root.clientHeight;
      const cell = Math.min(W / cols, H / rows);
      const ox = (W - cols * cell) / 2, oy = (H - rows * cell) / 2;

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, W, H);

      // 网格
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= cols; x++){
        ctx.beginPath(); ctx.moveTo(ox + x * cell, oy); ctx.lineTo(ox + x * cell, oy + rows * cell); ctx.stroke();
      }
      for (let y = 0; y <= rows; y++){
        ctx.beginPath(); ctx.moveTo(ox, oy + y * cell); ctx.lineTo(ox + cols * cell, oy + y * cell); ctx.stroke();
      }

      // 食物
      for (const f of cur.data.foods) dot(f[0], f[1], cell * 0.32, '#fbbf24', true);

      // 蛇
      const now = performance.now();
      const frac = Math.min(1, Math.max(0, (now - cur.time - Math.min(40, tickMs * 0.25)) / tickMs));

      for (const p of cur.data.players){
        const color = p.alive ? p.color : 'rgba(107,114,128,.45)';
        let bend = null;
        if (p.id === myId && p.alive && pendingTurns.length && frac > 0){
          const t0 = pendingTurns[0].sentAt + halfRtt;
          const kTurn = Math.ceil((t0 - (cur.time - halfRtt)) / tickMs);
          if (kTurn <= 1) bend = pendingTurns[0].dir;
        }
        for (let i = p.body.length - 1; i >= 0; i--){
          const g = lerpSeg(p, i, i === 0 ? bend : null, frac);
          dot(g[0], g[1], cell * (i === 0 ? 0.46 : 0.4), color, false);
        }
        if (p.alive && p.body.length){
          const h = lerpSeg(p, 0, null, frac);
          const hx = ox + (h[0] + 0.5) * cell, hy = oy + (h[1] + 0.5) * cell;
          const d = DIRS[bend || p.dir] || {x:0,y:0};
          const px = -d.y, py = d.x;
          const eo = cell * 0.16, fo = cell * 0.14;
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(hx + d.x * fo + px * eo, hy + d.y * fo + py * eo, cell * 0.09, 0, Math.PI * 2);
          ctx.arc(hx + d.x * fo - px * eo, hy + d.y * fo - py * eo, cell * 0.09, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const me = cur.data.players.find(p => p.id === myId);
      if (disconnected) drawMsg('已断线 · 按 Esc 退出后重新点积木', '#f87171');
      else if (me && !me.alive) drawMsg('按空格重生', '#fbbf24');
    }

    function dot(cx, cy, r, color, glow){
      const cell = Math.min(root.clientWidth / cols, root.clientHeight / rows);
      const ox = (root.clientWidth - cols * cell) / 2;
      const oy = (root.clientHeight - rows * cell) / 2;
      const x = ox + (cx + 0.5) * cell, y = oy + (cy + 0.5) * cell;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (glow){ ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    function lerpSeg(p, i, face, frac){
      const cell = Math.min(root.clientWidth / cols, root.clientHeight / rows);
      const cells = p.body;
      if (i === 0){
        const d = DIRS[face || p.dir] || {x:0,y:0};
        return [cells[0][0] + d.x * frac, cells[0][1] + d.y * frac];
      }
      const prev = cells[i - 1];
      return [cells[i][0] + (prev[0] - cells[i][0]) * frac, cells[i][1] + (prev[1] - cells[i][1]) * frac];
    }

    function drawMsg(text, color){
      const W = root.clientWidth, H = root.clientHeight;
      ctx.font = '600 28px system-ui,"PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(2,6,23,.55)';
      ctx.fillRect(0, H / 2 - 40, W, 80);
      ctx.fillStyle = color;
      ctx.fillText(text, W / 2, H / 2);
    }

    function quit(){
      if (!overlay) return;
      cancelAnimationFrame(raf);
      clearInterval(pingTimer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', resize);
      if (chatInput){ chatInput.remove(); chatInput = null; }
      try { if (ws) ws.close(); } catch (e) {}
      overlay.remove();
      overlay = null;
      myRoomId = null;
    }

    connect();
  }

  /* ============================================================
   * 扩展定义
   * ============================================================ */
  class SnakeNet {
    getInfo() {
      return {
        id: 'snakenet',
        name: '联机贪吃蛇',
        color1: '#3b82f6',
        color2: '#2f6bd6',
        color3: '#2454ab',
        blocks: [
          {
            blockType: Scratch.BlockType.COMMAND,
            opcode: 'startGame',
            text: '启动贪吃蛇 用户名 [USER] 密码 [PASS] 速度 [SPEED] 服务器 [URL]',
            arguments: {
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: '玩家' },
              PASS: { type: Scratch.ArgumentType.STRING, defaultValue: '1234' },
              SPEED: { type: Scratch.ArgumentType.STRING, menu: 'speeds', defaultValue: '200' },
              URL: { type: Scratch.ArgumentType.STRING, defaultValue: DEFAULT_URL }
            }
          }
        ],
        menus: {
          speeds: {
            acceptReporters: false,
            items: [
              { text: '慢速', value: '300' },
              { text: '标准', value: '200' },
              { text: '快速', value: '110' },
              { text: '超快', value: '50' }
            ]
          }
        }
      };
    }

    startGame(args) {
      const user = String(args.USER || '玩家').slice(0, 16) || '玩家';
      const pass = String(args.PASS || '1234').slice(0, 32) || '1234';
      const speed = Math.round(Number(args.SPEED)) || 200;
      const url = String(args.URL || DEFAULT_URL).trim() || DEFAULT_URL;
      if (typeof document === 'undefined' || !document.body) return;
      launch(user, pass, speed, url);
    }
  }

  Scratch.extensions.register(new SnakeNet());
})(Scratch);
