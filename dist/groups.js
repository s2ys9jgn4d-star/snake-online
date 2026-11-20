/* 群组面板：桌面端和手机端共用，自带样式与文案，不依赖页面既有结构 */
(function(){
  'use strict';

  var DICT = {
    'zh-CN': {
      group:'群组', create:'创建群', createPh:'输入群名（1-16 字）',
      search:'搜索', searchPh:'群名或群号', myGroups:'我的群',
      noGroups:'还没有加入任何群', owner:'群主', people:'人', enter:'进入', back:'返回',
      send:'发送', sendPh:'说点什么…', manage:'成员管理', requests:'入群申请',
      agree:'同意', reject:'拒绝', kick:'踢出', addFriend:'加好友',
      leave:'退出群', dissolve:'解散群', me:'我', joined:'已加入', applied:'已申请',
      apply:'申请加入', created:'群创建好了', reqSent:'申请已发送，等群主同意',
      kicked:'你被移出群聊', dissolved:'群已解散', reqArrived:'{name} 申请加入「{group}」',
      emptyChat:'还没有人说话，打个招呼吧', notFound:'没搜到群', confirmDissolve:'确定解散「{name}」？解散后记录都会消失',
      confirmLeave:'确定退出「{name}」？', maxTip:'每人最多创建 5 个群，请先删除几个群', youAreOwner:'你是群主'
    },
    'zh-TW': {
      group:'群組', create:'建立群組', createPh:'輸入群組名稱（1-16 字）',
      search:'搜尋', searchPh:'群組名稱或群組號', myGroups:'我的群組',
      noGroups:'還沒有加入任何群組', owner:'群主', people:'人', enter:'進入', back:'返回',
      send:'傳送', sendPh:'說點什麼…', manage:'成員管理', requests:'入群申請',
      agree:'同意', reject:'拒絕', kick:'踢出', addFriend:'加好友',
      leave:'退出群組', dissolve:'解散群組', me:'我', joined:'已加入', applied:'已申請',
      apply:'申請加入', created:'群組建立好了', reqSent:'申請已送出，等群主同意',
      kicked:'你被移出群組', dissolved:'群組已解散', reqArrived:'{name} 申請加入「{group}」',
      emptyChat:'還沒有人說話，打個招呼吧', notFound:'沒搜到群組', confirmDissolve:'確定解散「{name}」？解散後記錄都會消失',
      confirmLeave:'確定退出「{name}」？', maxTip:'每人最多建立 5 個群組，請先刪除幾個群組', youAreOwner:'你是群主'
    },
    'en': {
      group:'Groups', create:'Create', createPh:'Group name (1-16 chars)',
      search:'Search', searchPh:'Group name or ID', myGroups:'My groups',
      noGroups:'You have not joined any group yet', owner:'Owner', people:'members', enter:'Open', back:'Back',
      send:'Send', sendPh:'Say something…', manage:'Members', requests:'Join requests',
      agree:'Accept', reject:'Reject', kick:'Remove', addFriend:'Add friend',
      leave:'Leave', dissolve:'Delete group', me:'Me', joined:'Joined', applied:'Requested',
      apply:'Request to join', created:'Group created', reqSent:'Request sent, waiting for the owner',
      kicked:'You were removed from the group', dissolved:'The group was deleted',
      reqArrived:'{name} wants to join "{group}"', emptyChat:'No messages yet, say hi!',
      notFound:'No group found', confirmDissolve:'Delete "{name}"? All messages will be lost',
      confirmLeave:'Leave "{name}"?', maxTip:'You can own at most 5 groups, please delete some first', youAreOwner:'You are the owner'
    }
  };

  function langKey(){
    var l = (typeof window.getLang === 'function') ? window.getLang() : '';
    l = String(l || '');
    if (l.indexOf('zh-tw') === 0 || l.indexOf('zh-hk') === 0) return 'zh-TW';
    if (l.indexOf('zh') === 0) return 'zh-CN';
    return l ? 'en' : 'zh-CN';
  }
  function T(k, vars){
    var d = DICT[langKey()] || DICT['zh-CN'];
    var s = d[k] !== undefined ? d[k] : DICT['zh-CN'][k];
    if (vars) for (var key in vars) s = s.split('{' + key + '}').join(vars[key]);
    return s === undefined ? k : s;
  }
  function toast(msg){
    if (typeof window.showToast === 'function') window.showToast(msg);
  }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
    });
  }
  function token(){ return localStorage.getItem('snakeToken') || ''; }
  function meName(){ return localStorage.getItem('snakeUser') || ''; }

  async function api(path, body){
    var tk = token();
    var opt = { method: body === undefined ? 'GET' : 'POST', credentials:'include', headers:{} };
    if (tk) opt.headers['Authorization'] = 'Bearer ' + tk;
    if (body !== undefined) opt.headers['Content-Type'] = 'application/json', opt.body = JSON.stringify(body);
    try {
      var r = await fetch(path, opt);
      return await r.json();
    } catch (e){ return { ok:false, msg:'网络错误' }; }
  }
  function errText(r, fallback){
    if (r && r.key && typeof window.t === 'function'){
      var s = window.t(r.key);
      if (s && s !== r.key) return s;
    }
    return (r && r.msg) || fallback || '';
  }

  var CSS = ''
    + '.grp-mask{position:fixed;inset:0;background:rgba(6,10,20,.55);display:flex;align-items:center;justify-content:center;z-index:9000;}'
    + '.grp-box{width:min(560px,94vw);max-height:84vh;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;background:#141a26;color:#e8ecf6;border:1px solid #2a3550;box-shadow:0 24px 60px rgba(0,0,0,.45);font-size:14px;}'
    + 'html[data-theme="light"] .grp-box{background:#fff;color:#1b2437;border-color:#dbe6f7;box-shadow:0 24px 60px rgba(40,60,110,.18);}'
    + '.grp-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #2a3550;font-weight:600;}'
    + 'html[data-theme="light"] .grp-head{border-color:#e5ecf8;}'
    + '.grp-head .grow{flex:1;}'
    + '.grp-x{border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer;line-height:1;}'
    + '.grp-body{padding:12px 14px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:10px;}'
    + '.grp-row{display:flex;gap:8px;}'
    + '.grp-row input{flex:1;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid #2a3550;background:#0f1520;color:inherit;font-size:14px;}'
    + 'html[data-theme="light"] .grp-row input{background:#f7f9ff;border-color:#dbe6f7;}'
    + '.grp-btn{padding:8px 12px;border-radius:8px;border:1px solid #35507a;background:#1d2a44;color:#dce6fb;cursor:pointer;font-size:13px;white-space:nowrap;}'
    + 'html[data-theme="light"] .grp-btn{background:#eef4ff;border-color:#cfe0f8;color:#1d4ed8;}'
    + '.grp-btn.primary{background:#2f6df6;border-color:#2f6df6;color:#fff;}'
    + '.grp-btn.danger{background:#3a1b22;border-color:#7b2d3a;color:#ffb4c0;}'
    + '.grp-btn:disabled{opacity:.5;cursor:default;}'
    + '.grp-title{font-size:12px;opacity:.7;margin-top:4px;}'
    + '.grp-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:10px;border:1px solid #2a3550;background:#111828;}'
    + 'html[data-theme="light"] .grp-item{background:#f7f9ff;border-color:#e2ebf9;}'
    + '.grp-item .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
    + '.grp-msgs{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:4px 2px;min-height:180px;max-height:44vh;}'
    + '.grp-msg{max-width:82%;padding:7px 10px;border-radius:10px;background:#1b2740;word-break:break-word;}'
    + 'html[data-theme="light"] .grp-msg{background:#eef3fb;}'
    + '.grp-msg.mine{align-self:flex-end;background:#2f6df6;color:#fff;}'
    + '.grp-msg .who{font-size:11px;opacity:.65;margin-bottom:2px;}'
    + '.grp-msg.mine .who{opacity:.85;}'
    + '.grp-empty{opacity:.6;text-align:center;padding:24px 0;}'
    + '.grp-send{display:flex;gap:8px;padding-top:6px;}'
    + '.grp-send input{flex:1;min-width:0;padding:9px 10px;border-radius:8px;border:1px solid #2a3550;background:#0f1520;color:inherit;}'
    + 'html[data-theme="light"] .grp-send input{background:#f7f9ff;border-color:#dbe6f7;}'
    + '.grp-enter{margin-left:8px;font-size:12px;padding:3px 8px;border-radius:8px;border:1px solid #35507a;background:#1d2a44;color:#dce6fb;cursor:pointer;}'
    + 'html[data-theme="light"] .grp-enter{background:#eef4ff;border-color:#cfe0f8;color:#1d4ed8;}'
    + '@media (max-width:520px){.grp-box{width:100vw;height:100%;max-height:100%;border-radius:0;} .grp-msgs{max-height:none;}}';

  function injectCss(){
    if (document.getElementById('grpStyle')) return;
    var st = document.createElement('style');
    st.id = 'grpStyle';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  var mask = null, root = null, curGroup = null, chatTimer = null, pendingReq = 0;

  function close(){
    if (mask) mask.remove();
    mask = null; root = null; curGroup = null;
    if (chatTimer){ clearInterval(chatTimer); chatTimer = null; }
    pendingReq = 0;
  }

  function shell(){
    var m = document.createElement('div');
    m.className = 'grp-mask';
    m.innerHTML = '<div class="grp-box"><div class="grp-head"><span class="grow" data-role="title"></span>'
      + '<button class="grp-x" data-role="close">×</button></div><div class="grp-body" data-role="body"></div></div>';
    m.addEventListener('click', function(e){ if (e.target === m) close(); });
    m.querySelector('[data-role="close"]').onclick = close;
    document.body.appendChild(m);
    mask = m;
    root = m.querySelector('.grp-box');
    return m;
  }

  function head(title){
    root.querySelector('[data-role="title"]').textContent = title;
  }

  async function renderList(){
    var body = root.querySelector('[data-role="body"]');
    head(T('group'));
    body.innerHTML = '<div class="grp-row"><input data-role="newName" maxlength="16" placeholder="' + esc(T('createPh')) + '">'
      + '<button class="grp-btn primary" data-role="create">' + esc(T('create')) + '</button></div>'
      + '<div class="grp-row"><input data-role="q" placeholder="' + esc(T('searchPh')) + '">'
      + '<button class="grp-btn" data-role="find">' + esc(T('search')) + '</button></div>'
      + '<div class="grp-title">' + esc(T('myGroups')) + '</div><div data-role="list" class="grp-list"><div class="grp-empty">…</div></div>'
      + '<div data-role="found"></div>';

    body.querySelector('[data-role="create"]').onclick = async function(){
      var input = body.querySelector('[data-role="newName"]');
      var name = (input.value || '').trim();
      if (!name) return toast(T('createPh'));
      var r = await api('/api/group/create', { name: name });
      if (!r.ok) return toast(errText(r, T('maxTip')));
      input.value = '';
      toast(T('created'));
      renderList();
    };
    body.querySelector('[data-role="find"]').onclick = async function(){
      var q = (body.querySelector('[data-role="q"]').value || '').trim();
      var box = body.querySelector('[data-role="found"]');
      if (!q){ box.innerHTML = ''; return; }
      var r = await api('/api/group/find', { q: q });
      var items = (r && r.items) || [];
      if (!items.length){ box.innerHTML = '<div class="grp-empty">' + esc(T('notFound')) + '</div>'; return; }
      box.innerHTML = '<div class="grp-title">' + esc(T('search')) + '</div>';
      items.forEach(function(g){
        var row = document.createElement('div');
        row.className = 'grp-item';
        var label = g.joined ? T('joined') : (g.applied ? T('applied') : T('apply'));
        row.innerHTML = '<span class="name">' + esc(g.name) + ' · ' + g.count + ' ' + esc(T('people')) + '</span>';
        var b = document.createElement('button');
        b.className = 'grp-btn';
        b.textContent = label;
        b.disabled = g.joined || g.applied;
        b.onclick = async function(){
          var rr = await api('/api/group/apply', { id: g.id });
          if (!rr.ok) return toast(errText(rr));
          toast(rr.already ? T('joined') : (rr.applied ? T('applied') : T('reqSent')));
          b.disabled = true; b.textContent = T('applied');
        };
        row.appendChild(b);
        box.appendChild(row);
      });
    };

    var listBox = body.querySelector('[data-role="list"]');
    var r = await api('/api/groups');
    if (!r.ok){ listBox.innerHTML = '<div class="grp-empty">' + esc(errText(r)) + '</div>'; return; }
    var groups = r.items || [];
    if (!groups.length){ listBox.innerHTML = '<div class="grp-empty">' + esc(T('noGroups')) + '</div>'; return; }
    listBox.innerHTML = '';
    groups.forEach(function(g){
      var row = document.createElement('div');
      row.className = 'grp-item';
      row.innerHTML = '<span class="name">' + esc(g.name) + ' · ' + g.count + ' ' + esc(T('people'))
        + (g.isOwner ? ' · ' + esc(T('owner')) : '') + '</span>';
      if (g.reqs){ var badge = document.createElement('span'); badge.className = 'grp-title'; badge.textContent = T('requests') + ' ' + g.reqs; row.appendChild(badge); }
      var b = document.createElement('button');
      b.className = 'grp-btn'; b.textContent = T('enter');
      b.onclick = function(){ openGroup(g.id); };
      row.appendChild(b);
      listBox.appendChild(row);
    });
  }

  function renderMsg(m){
    var mine = m.from === meName();
    var div = document.createElement('div');
    div.className = 'grp-msg' + (mine ? ' mine' : '');
    div.innerHTML = (mine ? '' : '<div class="who">' + esc(m.from) + '</div>') + esc(m.text);
    return div;
  }

  async function openGroup(id){
    var r = await api('/api/group/detail', { id: id });
    if (!r.ok){ toast(errText(r)); return; }
    curGroup = r.group;
    renderChat();
    if (chatTimer) clearInterval(chatTimer);
    chatTimer = setInterval(async function(){
      if (!curGroup) return;
      var rr = await api('/api/group/detail', { id: curGroup.id });
      if (!rr.ok) return;
      var changed = JSON.stringify(rr.group.msgs) !== JSON.stringify(curGroup.msgs)
        || JSON.stringify(rr.group.members) !== JSON.stringify(curGroup.members)
        || JSON.stringify(rr.group.reqs) !== JSON.stringify(curGroup.reqs);
      curGroup = rr.group;
      if (changed) renderChat(true);
    }, 5000);
  }

  function renderChat(keepScroll){
    var body = root.querySelector('[data-role="body"]');
    head(curGroup.name);
    var isOwner = curGroup.owner === meName();
    body.innerHTML = '<div class="grp-row" style="align-items:center;">'
        + '<button class="grp-btn" data-role="back">← ' + esc(T('back')) + '</button>'
        + '<span style="flex:1;opacity:.75">' + curGroup.members.length + ' ' + esc(T('people'))
        + (isOwner ? ' · ' + esc(T('youAreOwner')) : '') + '</span>'
        + '<button class="grp-btn" data-role="manage">' + esc(T('manage')) + '</button></div>'
      + '<div class="grp-msgs" data-role="msgs"></div>'
      + '<div class="grp-send"><input data-role="text" maxlength="200" placeholder="' + esc(T('sendPh')) + '">'
      + '<button class="grp-btn primary" data-role="send">' + esc(T('send')) + '</button></div>';

    var msgs = body.querySelector('[data-role="msgs"]');
    if (!curGroup.msgs.length) msgs.innerHTML = '<div class="grp-empty">' + esc(T('emptyChat')) + '</div>';
    else curGroup.msgs.forEach(function(m){ msgs.appendChild(renderMsg(m)); });
    msgs.scrollTop = msgs.scrollHeight;

    body.querySelector('[data-role="back"]').onclick = function(){
      if (chatTimer){ clearInterval(chatTimer); chatTimer = null; }
      curGroup = null; renderList();
    };
    body.querySelector('[data-role="manage"]').onclick = renderManage;
    var input = body.querySelector('[data-role="text"]');
    async function send(){
      var text = (input.value || '').trim();
      if (!text) return;
      input.value = '';
      var rr = await api('/api/group/chat', { id: curGroup.id, text: text });
      if (!rr.ok) return toast(errText(rr));
      curGroup.msgs.push(rr.item);
      var box = body.querySelector('[data-role="msgs"]');
      if (box.querySelector('.grp-empty')) box.innerHTML = '';
      box.appendChild(renderMsg(rr.item));
      box.scrollTop = box.scrollHeight;
    }
    body.querySelector('[data-role="send"]').onclick = send;
    input.addEventListener('keydown', function(e){ if (e.key === 'Enter') send(); });
    if (!keepScroll) setTimeout(function(){ input.focus(); }, 50);
  }

  async function renderManage(){
    var g = curGroup;
    var isOwner = g.owner === meName();
    var body = root.querySelector('[data-role="body"]');
    head(g.name + ' · ' + T('manage'));
    body.innerHTML = '<div class="grp-title">' + esc(T('manage')) + '</div><div data-role="members"></div>'
      + '<div data-role="reqs"></div><div data-role="foot" class="grp-row" style="margin-top:8px;"></div>';

    var list = body.querySelector('[data-role="members"]');
    g.members.forEach(function(u){
      var row = document.createElement('div');
      row.className = 'grp-item';
      row.innerHTML = '<span class="name">' + esc(u) + (u === g.owner ? ' · ' + esc(T('owner')) : '')
        + (u === meName() ? ' · ' + esc(T('me')) : '') + '</span>';
      if (u !== meName()){
        var add = document.createElement('button');
        add.className = 'grp-btn'; add.textContent = T('addFriend');
        add.onclick = async function(){
          var rr = await api('/api/friend/request', { to: u });
          toast(rr.ok ? (rr.msg || T('reqSent')) : errText(rr));
        };
        row.appendChild(add);
      }
      if (isOwner && u !== g.owner){
        var kick = document.createElement('button');
        kick.className = 'grp-btn danger'; kick.textContent = T('kick');
        kick.onclick = async function(){
          var rr = await api('/api/group/kick', { id: g.id, user: u });
          if (!rr.ok) return toast(errText(rr));
          await openGroup(g.id);
          renderManage();
        };
        row.appendChild(kick);
      }
      list.appendChild(row);
    });

    if (isOwner && g.reqs.length){
      var reqBox = body.querySelector('[data-role="reqs"]');
      reqBox.innerHTML = '<div class="grp-title">' + esc(T('requests')) + '</div>';
      g.reqs.forEach(function(q){
        var row = document.createElement('div');
        row.className = 'grp-item';
        row.innerHTML = '<span class="name">' + esc(q.from) + '</span>';
        var ok = document.createElement('button');
        ok.className = 'grp-btn primary'; ok.textContent = T('agree');
        ok.onclick = async function(){
          var rr = await api('/api/group/accept', { id: g.id, user: q.from });
          if (!rr.ok) return toast(errText(rr));
          await openGroup(g.id); renderManage();
        };
        var no = document.createElement('button');
        no.className = 'grp-btn'; no.textContent = T('reject');
        no.onclick = async function(){
          var rr = await api('/api/group/reject', { id: g.id, user: q.from });
          if (!rr.ok) return toast(errText(rr));
          await openGroup(g.id); renderManage();
        };
        row.appendChild(ok); row.appendChild(no);
        reqBox.appendChild(row);
      });
    }

    var foot = body.querySelector('[data-role="foot"]');
    var back = document.createElement('button');
    back.className = 'grp-btn'; back.textContent = '← ' + T('back');
    back.onclick = function(){ openGroup(g.id); };
    foot.appendChild(back);
    if (isOwner){
      var del = document.createElement('button');
      del.className = 'grp-btn danger'; del.textContent = T('dissolve');
      del.onclick = async function(){
        if (!confirm(T('confirmDissolve', { name: g.name }))) return;
        var rr = await api('/api/group/delete', { id: g.id });
        if (!rr.ok) return toast(errText(rr));
        toast(T('dissolved')); close();
      };
      foot.appendChild(del);
    } else {
      var leave = document.createElement('button');
      leave.className = 'grp-btn danger'; leave.textContent = T('leave');
      leave.onclick = async function(){
        if (!confirm(T('confirmLeave', { name: g.name }))) return;
        var rr = await api('/api/group/leave', { id: g.id });
        if (!rr.ok) return toast(errText(rr));
        close();
      };
      foot.appendChild(leave);
    }
  }

  function open(){
    injectCss();
    if (mask) return;
    shell();
    renderList();
  }

  function onEvent(m){
    if (!m || !m.t) return;
    if (m.t === 'group_req'){
      toast(T('reqArrived', { name: m.from, group: m.name }));
      if (mask && !curGroup) renderList();
      return;
    }
    if (m.t === 'group_join'){ toast(T('joined') + ' ' + (m.name || '')); return; }
    if (m.t === 'group_kick'){ toast(T('kicked')); if (mask) close(); return; }
    if (m.t === 'group_delete'){ toast(T('dissolved')); if (mask) close(); return; }
    if (m.t === 'group_msg'){
      if (mask && curGroup && curGroup.id === m.id){
        curGroup.msgs.push({ from: m.from, text: m.text, ts: m.ts });
        var body = root.querySelector('[data-role="body"]');
        var box = body && body.querySelector('[data-role="msgs"]');
        if (box){
          if (box.querySelector('.grp-empty')) box.innerHTML = '';
          box.appendChild(renderMsg({ from: m.from, text: m.text, ts: m.ts }));
          box.scrollTop = box.scrollHeight;
        }
      }
      return;
    }
    if (m.t === 'group_member' && mask && curGroup && curGroup.id === m.id) openGroup(m.id);
  }

  function addEntry(){
    if (document.getElementById('groupBtn')) return;
    var heads = document.querySelectorAll('[data-i18n="friends"]');
    for (var i = 0; i < heads.length; i++){
      var h = heads[i];
      if (!h.parentNode) continue;
      if ((h.textContent || '').indexOf('👥') < 0) continue;
      var b = document.createElement('button');
      b.id = 'groupBtn';
      b.className = 'grp-enter';
      b.type = 'button';
      b.textContent = T('group');
      b.onclick = open;
      h.parentNode.insertBefore(b, h.nextSibling);
      return;
    }
  }

  // 样式在脚本加载时就注入：入口按钮 #groupBtn 一出现就有样式，不必等点开面板
  injectCss();

  window.Groups = { open: open, onEvent: onEvent };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addEntry);
  else addEntry();
})();
