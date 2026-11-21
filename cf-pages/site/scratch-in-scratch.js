/*
 * Scratch 套娃 —— TurboWarp / Scratch 自定义扩展
 *
 * 用法：添加扩展 → 自定义扩展 → 输入
 *   https://niesdemacbook-air.tail4f9990.ts.net/scratch-in-scratch.js
 *   ★ 必须勾选「在沙盒外运行」（unsandboxed）
 *
 * 默认使用「共创世界 ccw.site」的 Gandi 编辑器：
 *   国内 CDN，1.7MB 主包 0.4 秒，是 TurboWarp 的 7 倍速。
 */
(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('「Scratch 套娃」必须在沙盒外运行：添加扩展时勾选「在沙盒外运行」');
  }

  const CCW = 'https://www.ccw.site/gandi';   // 共创世界编辑器（国内）
  const TW  = 'https://turbowarp.org';        // TurboWarp（国外，较慢）

  function twPlayer(project) {
    const raw = String(project == null ? '' : project).trim();
    if (/^https?:\/\//i.test(raw) && /\/embed\b/.test(raw)) return raw;
    const m = raw.match(/(\d{5,})/);
    return m ? TW + '/' + m[1] + '/embed?autostart=true' : '';
  }

  class ScratchInScratch {
    constructor(runtime) {
      this.runtime = runtime;
      this.holder = null;
      this.onKey = null;
    }

    getInfo() {
      return {
        id: 'scratchInScratch',
        name: 'Scratch 套娃',
        color1: '#FF8C1A',
        color2: '#DB6E00',
        blocks: [
          {
            opcode: 'openEditor',
            blockType: Scratch.BlockType.COMMAND,
            text: '全屏打开 Scratch 编辑器（可编程·国内快）'
          },
          {
            opcode: 'openEditorWindow',
            blockType: Scratch.BlockType.COMMAND,
            text: '窗口打开编辑器 占屏宽 [WIDTH] % 居中',
            arguments: {
              WIDTH: { type: Scratch.ArgumentType.NUMBER, defaultValue: 86 }
            }
          },
          '---',
          {
            opcode: 'openPlayer',
            blockType: Scratch.BlockType.COMMAND,
            text: '全屏播放 TurboWarp 项目 [PROJECT]',
            arguments: {
              PROJECT: { type: Scratch.ArgumentType.STRING, defaultValue: '60917032' }
            }
          },
          {
            opcode: 'openExternal',
            blockType: Scratch.BlockType.COMMAND,
            text: '新窗口打开编辑器（最稳·绕过嵌入限制）'
          },
          '---',
          {
            opcode: 'close',
            blockType: Scratch.BlockType.COMMAND,
            text: '关闭套娃窗口'
          },
          {
            opcode: 'isOpen',
            blockType: Scratch.BlockType.BOOLEAN,
            text: '套娃窗口开着？'
          },
          {
            opcode: 'currentUrl',
            blockType: Scratch.BlockType.REPORTER,
            text: '当前套娃地址'
          }
        ]
      };
    }

    // ---------- 建容器 ----------
    _open(url, styleCss, label) {
      if (!url) return;
      this.close();

      const wrap = document.createElement('div');
      wrap.style.cssText =
        'position:fixed;z-index:2147483647;background:#14141f;' +
        'box-shadow:0 0 0 2px #222;overflow:hidden;' + styleCss;

      // 加载提示（iframe onload 后自动隐藏）
      const loading = document.createElement('div');
      loading.textContent = '正在加载 Scratch 编辑器…首次约 5-20 秒';
      loading.style.cssText =
        'position:absolute;inset:0;z-index:4;display:flex;align-items:center;' +
        'justify-content:center;background:#14141f;color:#9aa0b5;' +
        'font:600 15px system-ui,-apple-system,"PingFang SC",sans-serif;';

      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.setAttribute('allow', 'autoplay; fullscreen; microphone; camera; clipboard-read; clipboard-write; gamepad');
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
      iframe.onload = () => { loading.style.display = 'none'; };

      const bar = document.createElement('div');
      bar.textContent = label;
      bar.style.cssText =
        'position:absolute;top:0;left:0;right:0;height:32px;z-index:5;' +
        'display:flex;align-items:center;padding:0 12px;pointer-events:none;' +
        'background:linear-gradient(180deg,rgba(0,0,0,.75),rgba(0,0,0,0));' +
        'color:#fff;font:600 13px system-ui,-apple-system,"PingFang SC",sans-serif;';

      const btn = document.createElement('button');
      btn.textContent = '✕ 关闭 (Esc)';
      btn.style.cssText =
        'position:absolute;top:5px;right:8px;z-index:6;padding:6px 12px;' +
        'border:0;border-radius:8px;background:rgba(0,0,0,.7);color:#fff;' +
        'font:600 13px system-ui,-apple-system,"PingFang SC",sans-serif;cursor:pointer;';
      btn.onclick = () => this.close();

      wrap.appendChild(iframe);
      wrap.appendChild(loading);
      wrap.appendChild(bar);
      wrap.appendChild(btn);
      document.body.appendChild(wrap);

      this.holder = { wrap, iframe };
      this._bindEsc();
    }

    // ---------- 积木 ----------
    openEditor() {
      this._open(CCW, 'inset:0;', '共创世界 · Scratch 编辑器');
    }

    openEditorWindow(args) {
      const pct = Math.min(100, Math.max(30, Number(args.WIDTH) || 86));
      this._open(
        CCW,
        'left:50%;top:50%;transform:translate(-50%,-50%);' +
        'width:' + pct + 'vw;height:' + Math.round(pct * 0.72) + 'vh;border-radius:12px;',
        '共创世界 · 窗口模式'
      );
    }

    openPlayer(args) {
      const url = twPlayer(args.PROJECT);
      if (!url) return;
      this._open(url, 'inset:0;', 'TurboWarp 播放器 · 项目 ' + args.PROJECT);
    }

    openExternal() {
      window.open(CCW, '_blank', 'noopener');
    }

    close() {
      if (this.holder && this.holder.wrap.parentNode) {
        this.holder.wrap.parentNode.removeChild(this.holder.wrap);
      }
      this.holder = null;
      if (this.onKey) {
        window.removeEventListener('keydown', this.onKey, true);
        this.onKey = null;
      }
    }

    _bindEsc() {
      if (this.onKey) return;
      this.onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          this.close();
        }
      };
      window.addEventListener('keydown', this.onKey, true);
    }

    isOpen() { return !!this.holder; }

    currentUrl() { return this.holder ? this.holder.iframe.src : ''; }
  }

  Scratch.extensions.register(new ScratchInScratch());
})(Scratch);
