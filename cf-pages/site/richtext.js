/* 聊天增强：Markdown / LaTeX 渲染（用户可开关）+ 撤回按钮文案
 * 纯脚本、无依赖；KaTeX 放在 dist/vendor/katex，只有开启 LaTeX 时才加载
 * 对外：window.RichText = { get, set, on, render, mount, repaint, T }
 */
(function(){
  'use strict';

  var KEY = 'snakeRichText';

  function read(){
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
      return { md: !!o.md, tex: !!o.tex };
    } catch (e){ return { md:false, tex:false }; }
  }
  var state = read();

  function save(){
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e){}
  }

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
    });
  }

  // —— 文案（游戏主 i18n 用定长数组，这里只补聊天增强相关的几条，独立维护）——
  var DICT = {
    'zh-CN': { recall:'撤回', recalled:'已撤回了一条消息', md:'Markdown', tex:'LaTeX', rich:'聊天增强', richHint:'开启后可用 **粗体**、`代码`、$x^2$ 这类写法' },
    'zh-TW': { recall:'收回', recalled:'已收回了一則訊息', md:'Markdown', tex:'LaTeX', rich:'聊天增強', richHint:'開啟後可用 **粗體**、`程式碼`、$x^2$ 這類寫法' },
    'en':    { recall:'Recall', recalled:'A message was recalled', md:'Markdown', tex:'LaTeX', rich:'Rich chat', richHint:'Enable **bold**, `code` and $x^2$ style messages' }
  };
  function langKey(){
    var l = String((typeof window.getLang === 'function' ? window.getLang() : '') || '');
    if (l.indexOf('zh-tw') === 0 || l.indexOf('zh-hk') === 0) return 'zh-TW';
    if (l.indexOf('zh') === 0) return 'zh-CN';
    return 'en';
  }
  function T(k){
    var d = DICT[langKey()] || DICT['zh-CN'];
    return d[k] !== undefined ? d[k] : (DICT['zh-CN'][k] || k);
  }

  // —— KaTeX 懒加载 ——
  var katexReady = false, katexLoading = false, waiters = [];

  function loadCss(){
    if (document.getElementById('katexCss')) return;
    var l = document.createElement('link');
    l.id = 'katexCss';
    l.rel = 'stylesheet';
    l.href = 'vendor/katex/katex.min.css';
    document.head.appendChild(l);
  }

  function flush(){
    var list = waiters; waiters = [];
    for (var i = 0; i < list.length; i++){ try { list[i](); } catch (e){} }
  }

  function ensureKatex(cb){
    if (cb) waiters.push(cb);
    if (katexReady){ flush(); return; }
    if (katexLoading) return;
    katexLoading = true;
    loadCss();
    var s = document.createElement('script');
    s.src = 'vendor/katex/katex.min.js';
    s.onload = function(){
      katexReady = (typeof window.katex !== 'undefined' && !!window.katex.renderToString);
      katexLoading = false;
      flush();
    };
    s.onerror = function(){   // 加载失败就退回纯文本显示 $...$，不阻塞聊天
      katexLoading = false;
      katexReady = false;
      flush();
    };
    document.head.appendChild(s);
  }

  function renderMath(item){
    var src = item.m;
    if (!katexReady) return esc((item.d ? '$$' + src + '$$' : '$' + src + '$'));
    try {
      return window.katex.renderToString(src, {
        displayMode: !!item.d,
        throwOnError: false,
        errorColor: '#d9534f',
        output: 'html',
        trust: false
      });
    } catch (e){
      return esc(item.d ? '$$' + src + '$$' : '$' + src + '$');
    }
  }

  // —— 渲染主体 ——
  // 先整体转义，再做 Markdown 替换，所以用户输入的标签不会被当成 HTML 执行
  function renderHtml(text){
    var src = String(text == null ? '' : text).replace(/\r\n/g, '\n');

    // 1) 代码块先抽出来，避免里面的 # * _ 被当成语法
    var blocks = [];
    src = src.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, function(_, code){
      blocks.push(code.replace(/\n$/, ''));
      return '\u0001B' + (blocks.length - 1) + '\u0001';
    });

    var out = esc(src);

    // 2) 公式占位（此时已是转义文本，$ 不受影响）
    var maths = [];
    if (state.tex){
      out = out.replace(/\$\$([\s\S]+?)\$\$/g, function(_, m){
        maths.push({ m: m, d: true });
        return '\u0002M' + (maths.length - 1) + '\u0002';
      });
      out = out.replace(/\$([^\$\n]+?)\$/g, function(_, m){
        maths.push({ m: m, d: false });
        return '\u0002M' + (maths.length - 1) + '\u0002';
      });
    }

    // 3) 行内代码
    out = out.replace(/`([^`\n]+)`/g, '<code class="rt-inline">$1</code>');

    if (state.md){
      // 链接：只放行 http/https，其余按纯文本留着
      out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function(_, label, url){
        return '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      });
      // 裸链接
      out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, function(_, pre, url){
        return pre + '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
      });
      out = out.replace(/~~([^~\n]+)~~/g, '<span class="rt-strike">$1</span>');
      out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      out = out.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
      out = out.replace(/^#{1,4}\s+(.+)$/gm, '<b class="rt-h">$1</b>');
      out = out.replace(/^&gt;\s+(.+)$/gm, '<span class="rt-quote">$1</span>');
      out = out.replace(/^[-*]\s+(.+)$/gm, '• $1');
    }

    // 4) 换行（代码块和公式是占位符，不会被插到 <br> 里）
    out = out.replace(/\n/g, '<br>');

    // 5) 还原代码块与公式
    out = out.replace(/\u0001B(\d+)\u0001/g, function(_, i){
      return '<pre class="rt-code"><code>' + esc(blocks[Number(i)]) + '</code></pre>';
    });
    out = out.replace(/\u0002M(\d+)\u0002/g, function(_, i){ return renderMath(maths[Number(i)]); });

    return out;
  }

  function isOn(){ return state.md || state.tex; }

  // 把一条消息渲染到元素里；原文挂在 data-rt 上，KaTeX 加载完可以重画
  function mount(el, text){
    if (!el) return;
    var raw = String(text == null ? '' : text);
    el.setAttribute('data-rt', raw);
    if (!isOn()){
      el.classList.remove('rt');
      el.textContent = raw;
      return;
    }
    el.classList.add('rt');
    if (state.tex && !katexReady) ensureKatex(repaint);
    el.innerHTML = renderHtml(raw);
  }

  function repaint(){
    var nodes = document.querySelectorAll('[data-rt]');
    for (var i = 0; i < nodes.length; i++){
      var el = nodes[i];
      el.innerHTML = renderHtml(el.getAttribute('data-rt'));
    }
  }

  function set(key, val){
    if (key !== 'md' && key !== 'tex') return state;
    state[key] = !!val;
    save();
    if (state.tex && state[key]) ensureKatex(repaint);
    repaint();
    return state;
  }

  window.RichText = {
    get: function(){ return { md: state.md, tex: state.tex }; },
    set: set,
    on: isOn,
    render: renderHtml,
    mount: mount,
    repaint: repaint,
    ensureKatex: ensureKatex,
    T: T
  };
})();
