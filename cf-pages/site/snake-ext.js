/*
 * 联机贪吃蛇扩展 —— TurboWarp / Scratch 联机扩展（网页版启动器）
 *
 * 用法：TurboWarp → 添加扩展 → 自定义扩展 → 输入
 *   https://snake-downloads.pages.dev/snake-ext.js
 *   ★ 必须勾选「在沙盒外运行」
 *
 * 点「开始游戏」积木 = 全屏打开官方网页版（登录 / 房间 / 排行榜全都有）。
 * 网页版更新了这里自动跟着更新，积木永远不会过时。
 * 按 Esc 或右上角按钮退出全屏，回到编辑器。
 */
(function (Scratch) {
  'use strict';

  const DEFAULT_PAGE = 'https://snake-downloads.pages.dev/play.html';

  let overlay = null; // DOM 全屏覆盖层，null 表示没打开

  function open(page) {
    if (overlay) return; // 已经在玩了

    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#0f172a;';

    const frame = document.createElement('iframe');
    frame.src = page;
    frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;';

    const close = document.createElement('button');
    close.textContent = '✕ 退出（Esc）';
    close.style.cssText =
      'position:absolute;top:10px;right:12px;z-index:2;padding:6px 14px;border:0;border-radius:8px;' +
      'background:rgba(15,23,42,.78);color:#e2e8f0;font-size:13px;cursor:pointer;';
    close.onclick = quit;

    root.appendChild(frame);
    root.appendChild(close);
    document.body.appendChild(root);
    overlay = root;

    window.addEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') quit();
  }

  function quit() {
    if (!overlay) return;
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
    overlay = null;
  }

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
            text: '全屏开始游戏 昵称 [NAME] 速度 [SPEED] 页面 [URL]',
            arguments: {
              NAME: { type: Scratch.ArgumentType.STRING, defaultValue: '玩家' },
              SPEED: { type: Scratch.ArgumentType.STRING, menu: 'speeds', defaultValue: '200' },
              URL: { type: Scratch.ArgumentType.STRING, defaultValue: DEFAULT_PAGE }
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
              { text: '极速', value: '50' }
            ]
          }
        }
      };
    }

    startGame(args) {
      // 昵称 / 速度两个参数留给旧工程兼容（网页版自己管登录和速度）
      let page = String(args.URL || '').trim();
      if (!/^https?:\/\//i.test(page)) page = DEFAULT_PAGE;
      if (typeof document === 'undefined' || !document.body) return;
      open(page);
    }
  }

  Scratch.extensions.register(new SnakeNet());
})(Scratch);
