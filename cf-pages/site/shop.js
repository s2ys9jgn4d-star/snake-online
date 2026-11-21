/* 皮肤商店 + 每日签到（服务端 /api/shop 系列接口为唯一权威） */
(function(){
  const CSS = `
#shopMask{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(4,7,14,.72);backdrop-filter:blur(4px)}
#shopMask.open{display:flex}
#shopCard{width:min(560px,92vw);max-height:86vh;overflow:auto;background:#161c33;border:1px solid rgba(122,142,224,.25);border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.55);color:#e9eeff;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px 22px 16px}
.shop-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.shop-head h2{margin:0;font-size:19px;font-weight:700}
.shop-close{border:0;background:transparent;color:#8b95bd;font-size:22px;cursor:pointer;line-height:1;padding:2px 6px}
.shop-wallet{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#1e2643;border-radius:12px;padding:12px 14px;margin-bottom:14px}
.shop-coins{font-weight:700;color:#facc15;font-size:16px}
.shop-streak{color:#8b95bd;font-size:12px}
.shop-checkin{margin-left:auto;border:0;border-radius:10px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#5b8cff,#22d3ee);color:#08101f}
.shop-checkin[disabled]{background:#2a3358;color:#8b95bd;cursor:default}
.shop-tip{font-size:12px;color:#8b95bd;margin:-6px 0 12px;line-height:1.6}
.shop-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.shop-item{background:#1e2643;border:1px solid rgba(122,142,224,.14);border-radius:14px;padding:12px 13px;display:flex;flex-direction:column;gap:8px}
.shop-item.on{border-color:#5b8cff;box-shadow:0 0 0 1px #5b8cff inset}
.shop-tit{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.shop-name{font-weight:600}
.shop-price{font-size:12px;color:#facc15;white-space:nowrap}
.shop-price.free{color:#34d399}
.shop-dots{display:flex;gap:5px;align-items:center;height:18px}
.shop-dots span{width:11px;height:11px;border-radius:50%;display:block}
.shop-desc{font-size:12px;color:#8b95bd;min-height:18px}
.shop-btn{border:0;border-radius:9px;padding:8px 10px;font-size:13px;font-weight:600;cursor:pointer;background:#5b8cff;color:#fff}
.shop-btn.ghost{background:#2a3358;color:#c7d0f5}
.shop-btn.owned{background:#22315a;color:#8fd3ff}
.shop-btn[disabled]{background:#2a3358;color:#6b7599;cursor:default}
.shop-foot{margin-top:14px;padding-top:12px;border-top:1px solid rgba(122,142,224,.18);font-size:12px;color:#8b95bd;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.shop-foot a{color:#8fd3ff;text-decoration:none}
#shopToast{position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:10000;background:rgba(15,22,42,.96);border:1px solid rgba(122,142,224,.3);color:#e9eeff;padding:9px 16px;border-radius:10px;font-size:13px;display:none}
#shopToast.show{display:block}
@media (max-width:520px){.shop-grid{grid-template-columns:1fr}}
`;
  function injectCss(){
    if (document.getElementById('shopCss')) return;
    const st = document.createElement('style');
    st.id = 'shopCss'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  function toast(msg){
    let el = document.getElementById('shopToast');
    if (!el){ el = document.createElement('div'); el.id = 'shopToast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  const dotStyle = sk => {
    if (sk.id === 'rainbow') return ['#ff4d4d','#ffb020','#34d399','#38bdf8','#a855f7'];
    const base = sk.color || '#22c55e';
    return [base, base, base, base];
  };

  // 文案统一走 i18n；老版本 / 没装 i18n 时回落到 key，英文由 i18n 兜底
  const T = (k, v) => (typeof window.t === 'function' ? window.t(k, v) : k);
  const skinText = (sk, suffix) => {
    const k = 'skin_' + sk.id + (suffix || '');
    const v = T(k);
    return (v && v !== k) ? v : (suffix ? (sk.desc || '') : (sk.name || ''));
  };

  let data = null; let dataAt = 0;

  async function load(force){
    const api = window.SNAKE.api;
    // 两分钟内的数据直接用缓存，打开商店不必再等接口
    if (!force && data && data.ok && Date.now() - dataAt < 120000){ render(); return; }
    data = await api('/api/shop');
    if (!data || !data.ok){
      if (data && data.msg) toast(data.msg);
      return;
    }
    dataAt = Date.now();
    render();
  }

  // 进大厅后后台预取一次，把首次打开商店的等待挪到用户不注意的时候
  function prefetch(){
    setTimeout(async () => {
      if (!window.SNAKE || !window.SNAKE.user()) return;
      if (data && data.ok) return;
      try {
        const d = await window.SNAKE.api('/api/shop');
        if (d && d.ok){ data = d; dataAt = Date.now(); }
      } catch (e) {}
    }, 1200);
  }

  async function checkin(){
    const r = await window.SNAKE.api('/api/shop/checkin', { method:'POST', body:'{}' });
    if (!r || !r.ok){ toast((r && r.msg) || T('shop_checkinFail')); return; }
    toast(T('shop_checkinOk', { n: r.reward, s: r.streak }));
    await load(true);
  }

  async function buy(id){
    const r = await window.SNAKE.api('/api/shop/buy', { method:'POST', body: JSON.stringify({ id }) });
    if (!r || !r.ok){ toast((r && r.msg) || T('shop_buyFail')); return; }
    toast(T('shop_buyOk'));
    await load(true);
  }

  async function equip(id){
    const r = await window.SNAKE.api('/api/shop/equip', { method:'POST', body: JSON.stringify({ id }) });
    if (!r || !r.ok){ toast((r && r.msg) || T('shop_equipFail')); return; }
    toast(T('shop_equipOk'));
    await load(true);
  }

  function render(){
    const box = document.getElementById('shopBody');
    if (!box || !data) return;
    const guest = !!data.guest;
    box.innerHTML = '';

    const wallet = document.createElement('div');
    wallet.className = 'shop-wallet';
    wallet.innerHTML = '<span class="shop-coins">🪙 ' + (data.coins || 0) + '</span>'
      + '<span class="shop-streak">' + (guest ? T('shop_guestNoCoins') : T('shop_streak', { n: data.streak || 0 })) + '</span>';
    const btn = document.createElement('button');
    btn.className = 'shop-checkin';
    if (guest){ btn.textContent = T('shop_guestNoCheckin'); btn.disabled = true; }
    else if (data.checkedToday){ btn.textContent = T('shop_checked'); btn.disabled = true; }
    else { btn.textContent = T('shop_checkin'); btn.onclick = checkin; }
    wallet.appendChild(btn);
    box.appendChild(wallet);

    const tip = document.createElement('p');
    tip.className = 'shop-tip';
    tip.textContent = guest
      ? T('shop_tipGuest')
      : T('shop_tip');
    box.appendChild(tip);

    const grid = document.createElement('div');
    grid.className = 'shop-grid';
    for (const sk of (data.skins || [])){
      const owned = sk.id === 'classic' || (data.owned || []).includes(sk.id);
      const equipped = (data.skin || 'classic') === sk.id;
      const item = document.createElement('div');
      item.className = 'shop-item' + (equipped ? ' on' : '');

      const tit = document.createElement('div');
      tit.className = 'shop-tit';
      tit.innerHTML = '<span class="shop-name">' + skinText(sk) + '</span>'
        + (sk.price > 0
            ? '<span class="shop-price">🪙 ' + sk.price + '</span>'
            : '<span class="shop-price free">' + T('shop_free') + '</span>');
      item.appendChild(tit);

      const dots = document.createElement('div');
      dots.className = 'shop-dots';
      for (const c of dotStyle(sk)){
        const d = document.createElement('span');
        d.style.background = c;
        if (sk.glow) d.style.boxShadow = '0 0 8px ' + c;
        dots.appendChild(d);
      }
      item.appendChild(dots);

      const desc = document.createElement('div');
      desc.className = 'shop-desc';
      desc.textContent = skinText(sk, 'D');
      item.appendChild(desc);

      const b = document.createElement('button');
      if (equipped){
        b.className = 'shop-btn owned'; b.textContent = T('shop_using'); b.disabled = true;
      } else if (owned){
        b.className = 'shop-btn ghost'; b.textContent = T('shop_equip'); b.onclick = () => equip(sk.id);
      } else if (guest){
        b.className = 'shop-btn'; b.textContent = T('shop_needSignup'); b.disabled = true;
      } else {
        b.className = 'shop-btn'; b.textContent = T('shop_buy');
        if ((data.coins || 0) < sk.price){ b.disabled = true; b.textContent = T('shop_noCoins'); }
        else b.onclick = () => buy(sk.id);
      }
      item.appendChild(b);
      grid.appendChild(item);
    }
    box.appendChild(grid);

    const foot = document.createElement('div');
    foot.className = 'shop-foot';
    foot.innerHTML = '<span>' + T('shop_footA') + '<a href="https://afdian.com/" target="_blank" rel="noopener">' + T('shop_footB') + '</a> ' + T('shop_footC') + '</span>'
      + '<span>' + T('shop_footTip') + '</span>';
    box.appendChild(foot);

    // 大厅那边的「当前皮肤」预览跟着变
    try { window.dispatchEvent(new CustomEvent('skinchanged', { detail: { skin: data.skin || 'classic' } })); } catch (e) {}
  }

  function build(){
    injectCss();
    const mask = document.createElement('div');
    mask.id = 'shopMask';
    mask.innerHTML = '<div id="shopCard"><div class="shop-head"><h2>🎨 ' + T('shop_title') + '</h2><button class="shop-close" aria-label="' + T('close') + '">×</button></div><div id="shopBody"></div></div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', e => { if (e.target === mask) mask.classList.remove('open'); });
    mask.querySelector('.shop-close').onclick = () => mask.classList.remove('open');

    const btn = document.createElement('button');
    btn.id = 'shopBtn';
    btn.className = 'ghost-btn';
    btn.textContent = '🎨 ' + T('shop_title');
    btn.onclick = async () => {
      // Cookie 身份也算登录：接口范层面会用 Cookie 校验，前端不拦
      if (!window.SNAKE || !window.SNAKE.user()){ toast(T('shop_loginFirst')); return; }
      mask.classList.add('open');
      await load();
    };
    const anchor = document.getElementById('settingsBtn');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor);

    // 给大厅「当前皮肤」用：读缓存 / 直接开面板
    window.SNAKE_SHOP = {
      current: function(){ return (data && data.ok) ? data : null; },
      open: function(){
        if (!window.SNAKE || !window.SNAKE.user()){ toast(T('shop_loginFirst')); return; }
        mask.classList.add('open'); load();
      }
    };
  }

  // 深链接：#shop 直接打开商店（也方便截图和演示）
  function autoOpen(){
    if (location.hash !== '#shop') return;
    const mask = document.getElementById('shopMask');
    if (!mask) return;
    if (!window.SNAKE || !window.SNAKE.user()) return;
    mask.classList.add('open');
    load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { build(); setTimeout(autoOpen, 900); prefetch(); });
  else { build(); setTimeout(autoOpen, 900); prefetch(); }
})();
