#!/usr/bin/env node
/*
 * 联机贪吃蛇 · 一键打包
 *   node 打包.js            只打包，结果落 dist/ 和 release/
 *   node 打包.js --upload v1.0.3   打完顺便传 GitHub Release
 *
 * 思路：五个包都是"网页壳"，所以不重新造壳 ——
 *   先把上一次的成品包当模板（pack-base/），解出壳 + 网页资源，
 *   换掉网页资源，再原样打回去（apk 重新签名、dmg 重新 ad-hoc 签名）。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync, spawnSync } = require('child_process')

const ROOT = __dirname
const DIST = path.join(ROOT, 'dist')
const BASE = path.join(ROOT, 'pack-base')
const REL = path.join(ROOT, 'release')
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-pack-'))

// 网页资源清单（放在各包 html/assets 目录里的那些）
const WEB_FILES = [
  'index.html', 'play.html', 'mobile.html',
  'game.js', 'mobile.js', 'i18n.js', 'groups.js', 'snake-ext.js',
  'style.css', 'mobile.css',
  'admin.html', 'terms.html', 'qr.html', 'favicon.png'
]

const PKG = {
  dmg: { file: '贪吃蛇.dmg', out: 'snake-online.dmg' },
  ipa: { file: '贪吃蛇-unsigned.ipa', out: 'snake-online-unsigned.ipa' },
  win: { file: '贪吃蛇-win64.zip', out: 'snake-online-win64.zip' },
  apk: { file: '贪吃蛇.apk', out: 'snake-online.apk' },
  deb: { file: '贪吃蛇.deb', out: 'snake-online.deb' }
}

const log = (s) => console.log(s)
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (r.status !== 0) {
    const tail = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(-6).join('\n')
    throw new Error(`命令失败：${cmd} ${args.join(' ')}\n${tail}`)
  }
  return (r.stdout || '').trim()
}
const sizeOf = (f) => fs.statSync(f).size
const mb = (n) => (n / 1048576).toFixed(2) + ' MB'

function findApkTools() {
  const cands = [
    '/opt/homebrew/share/android-commandlinetools/build-tools/34.0.0',
    path.join(os.homedir(), '.snake-apk/bt/android-14'),
    path.join(os.homedir(), 'Library/Android/sdk/build-tools')
  ]
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'apksigner'))) return c
  }
  for (const root of ['/opt/homebrew/share/android-commandlinetools/build-tools', path.join(os.homedir(), 'Library/Android/sdk/build-tools')]) {
    if (!fs.existsSync(root)) continue
    for (const v of fs.readdirSync(root).sort().reverse()) {
      const d = path.join(root, v)
      if (fs.existsSync(path.join(d, 'apksigner'))) return d
    }
  }
  throw new Error('找不到 apksigner / zipalign（装一下 android build-tools）')
}

// ---------- 1. 准备模板 ----------
function ensureBase() {
  fs.mkdirSync(BASE, { recursive: true })
  for (const k of Object.keys(PKG)) {
    const b = path.join(BASE, PKG[k].file)
    const d = path.join(DIST, PKG[k].file)
    if (fs.existsSync(b)) continue
    if (!fs.existsSync(d)) throw new Error(`缺模板包，也没有现成的 ${PKG[k].file} 可以当模板`)
    fs.copyFileSync(d, b)
    log(`  模板初始化：pack-base/${PKG[k].file}`)
  }
}

// ---------- 2. 换网页资源 ----------
function syncWeb(htmlDir) {
  fs.mkdirSync(htmlDir, { recursive: true })
  for (const f of WEB_FILES) {
    const src = path.join(DIST, f)
    if (!fs.existsSync(src)) { log(`  ! 跳过缺失资源 ${f}`); continue }
    fs.copyFileSync(src, path.join(htmlDir, f))
  }
}

// ---------- 图片瘦身（目标是每个包 ≤ 1 MB）----------
const SRC_ICON = path.join(ROOT, 'ios', 'SnakeOnline', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon1024.png')

const PY_SHRINK = `
import sys
from PIL import Image
task = sys.argv[1]
if task == 'png':
    src, dst, px, colors = sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
    im = Image.open(src).convert('RGBA')
    im.thumbnail((px, px), Image.LANCZOS)
    im.convert('P', palette=Image.ADAPTIVE, colors=colors).save(dst, optimize=True)
elif task == 'quant':
    f, colors = sys.argv[2], int(sys.argv[3])
    im = Image.open(f).convert('RGBA')
    im.convert('P', palette=Image.ADAPTIVE, colors=colors).save(f, optimize=True)
elif task == 'sizes':
    src, outdir = sys.argv[2], sys.argv[3]
    im = Image.open(src).convert('RGBA')
    for px in (16, 32, 64, 128, 256):
        im.resize((px, px), Image.LANCZOS).convert('P', palette=Image.ADAPTIVE, colors=256).save(outdir + '/d_%d.png' % px, optimize=True)
elif task == 'ico':
    src, dst = sys.argv[2], sys.argv[3]
    im = Image.open(src).convert('RGBA')
    im.save(dst, format='ICO', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
`
const pyImg = (...args) => run('python3', ['-c', PY_SHRINK, ...args], { quiet: true })

function shrinkPng(src, dst, px, colors = 256) {
  pyImg('png', src, dst, String(px), String(colors))
}

// 网页里那张 121 KB 的 favicon → 128px 量化
function shrinkFavicon(dir) {
  const f = path.join(dir, 'favicon.png')
  if (!fs.existsSync(f)) return
  const tmp = f + '.tmp.png'
  shrinkPng(f, tmp, 128, 128)
  fs.renameSync(tmp, f)
}

// iOS 一堆 AppIcon*.png 逐个量化（尺寸不变，只减颜色和压缩率）
function shrinkIpaIcons(appDir) {
  for (const f of fs.readdirSync(appDir)) {
    if (!/^AppIcon.*\.png$/.test(f)) continue
    pyImg('quant', path.join(appDir, f), '256')
  }
}

// macOS 的 snake.icns：用 1024 原图重做一套到 256，体积从 1.5 MB 掉到 ~150 KB
function rebuildIcns(resDir) {
  const set = path.join(WORK, 'Snake.iconset')
  fs.rmSync(set, { recursive: true, force: true })
  fs.mkdirSync(set, { recursive: true })
  pyImg('sizes', SRC_ICON, set)
  for (const px of [16, 32, 64, 128, 256]) {
    fs.copyFileSync(path.join(set, `d_${px}.png`), path.join(set, `icon_${px}x${px}.png`))
    if (px <= 128) fs.copyFileSync(path.join(set, `d_${px}.png`), path.join(set, `icon_${px}x${px}@2x.png`))
  }
  run('iconutil', ['-c', 'icns', set, '-o', path.join(resDir, 'snake.icns')], { quiet: true })
}

// Windows 壳自带的 icon.ico 282 KB，压到多尺寸 ICO
function shrinkIco(file) {
  if (!fs.existsSync(file) || !fs.existsSync(SRC_ICON)) return
  const tmp = file + '.tmp.ico'
  pyImg('ico', SRC_ICON, tmp)
  fs.renameSync(tmp, file)
}

// 应用包版权（Info.plist 的 NSHumanReadableCopyright）
function stampCopyright(plist) {
  if (!fs.existsSync(plist)) return
  const v = '© 2026 Nie Qizhong, Inc.'
  const pb = '/usr/libexec/PlistBuddy'
  spawnSync(pb, ['-c', 'Set :NSHumanReadableCopyright ' + v, plist], { encoding: 'utf8' })
  const ok = spawnSync(pb, ['-c', 'Print :NSHumanReadableCopyright', plist], { encoding: 'utf8' })
  if (ok.status !== 0) spawnSync(pb, ['-c', 'Add :NSHumanReadableCopyright string ' + v, plist], { encoding: 'utf8' })
}

// 包里用不到的站点文件
function dropSiteOnly(htmlDir) {
  for (const f of ['robots.txt', 'admin.html']) {
    fs.rmSync(path.join(htmlDir, f), { force: true })
  }
}

// 各平台的壳都写死加载 index.html（那是官网下载页），
// 所以打包时把 index.html 换成直接进游戏页的入口。
const SITE = 'https://snake-online.up.railway.app'

function writeEntry(htmlDir) {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>贪吃蛇</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>html,body{margin:0;height:100%;background:#ABCDEF;color:#123;font:16px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center}</style>
</head><body><div><p>正在进入联机贪吃蛇…</p><p><a id="l" href="${SITE}/play.html">没反应？点这里</a></p></div>
<script>
var phone = /Android|iPhone|iPad|iPod|HarmonyOS/i.test(navigator.userAgent) || Math.min(screen.width, screen.height) < 700;
var url = "${SITE}/" + (phone ? "mobile.html" : "play.html");
document.getElementById("l").href = url;
location.replace(url);
</script></body></html>`
  fs.writeFileSync(path.join(htmlDir, 'index.html'), html)
}

// ---------- 3. 五个包 ----------
function buildWin() {
  const dir = path.join(WORK, 'win')
  run('unzip', ['-q', path.join(BASE, PKG.win.file), '-d', dir], { quiet: true })
  syncWeb(path.join(dir, 'Snake-win64', 'html'))
  writeEntry(path.join(dir, 'Snake-win64', 'html'))
  shrinkFavicon(path.join(dir, 'Snake-win64', 'html'))
  dropSiteOnly(path.join(dir, 'Snake-win64', 'html'))
  shrinkIco(path.join(dir, 'Snake-win64', 'icon.ico'))
  const out = path.join(DIST, PKG.win.file)
  fs.rmSync(out, { force: true })
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    run('zip', ['-q', '-r', '-X', out, 'Snake-win64'], { quiet: true })
  } finally { process.chdir(cwd) }
  return out
}

function buildIpa() {
  const dir = path.join(WORK, 'ipa')
  run('unzip', ['-q', path.join(BASE, PKG.ipa.file), '-d', dir], { quiet: true })
  syncWeb(path.join(dir, 'Payload', 'SnakeOnline.app', 'html'))
  writeEntry(path.join(dir, 'Payload', 'SnakeOnline.app', 'html'))
  shrinkFavicon(path.join(dir, 'Payload', 'SnakeOnline.app', 'html'))
  dropSiteOnly(path.join(dir, 'Payload', 'SnakeOnline.app', 'html'))
  shrinkIpaIcons(path.join(dir, 'Payload', 'SnakeOnline.app'))
  stampCopyright(path.join(dir, 'Payload', 'SnakeOnline.app', 'Info.plist'))
  const out = path.join(DIST, PKG.ipa.file)
  fs.rmSync(out, { force: true })
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    run('zip', ['-q', '-r', '-X', out, 'Payload'], { quiet: true })
  } finally { process.chdir(cwd) }
  return out
}

function buildDmg() {
  const mnt = path.join(WORK, 'mnt')
  fs.mkdirSync(mnt, { recursive: true })
  const app = path.join(WORK, 'dmgapp')
  run('hdiutil', ['attach', '-nobrowse', '-quiet', path.join(BASE, PKG.dmg.file), '-mountpoint', mnt], { quiet: true })
  try {
    run('cp', ['-R', path.join(mnt, '贪吃蛇.app'), app], { quiet: true })
  } finally {
    run('hdiutil', ['detach', '-quiet', mnt], { quiet: true })
  }
  syncWeb(path.join(app, 'Contents', 'Resources', 'html'))
  writeEntry(path.join(app, 'Contents', 'Resources', 'html'))
  shrinkFavicon(path.join(app, 'Contents', 'Resources', 'html'))
  dropSiteOnly(path.join(app, 'Contents', 'Resources', 'html'))
  rebuildIcns(path.join(app, 'Contents', 'Resources'))
  stampCopyright(path.join(app, 'Contents', 'Info.plist'))
  // 改过内容，原签名失效，重新临时签名
  try { fs.rmSync(path.join(app, 'Contents', '_CodeSignature'), { recursive: true, force: true }) } catch {}
  run('codesign', ['--force', '--deep', '--sign', '-', app], { quiet: true })
  run('codesign', ['--verify', '--deep', '--strict', app], { quiet: true })

  const stage = path.join(WORK, 'stage')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  run('cp', ['-R', app, path.join(stage, '贪吃蛇.app')], { quiet: true })

  const out = path.join(DIST, PKG.dmg.file)
  fs.rmSync(out, { force: true })
  run('hdiutil', ['create', '-quiet', '-volname', '联机贪吃蛇', '-srcfolder', stage, '-ov', '-format', 'UDZO', out], { quiet: true })
  return out
}

function buildApk() {
  const dir = path.join(WORK, 'apk')
  run('unzip', ['-q', path.join(BASE, PKG.apk.file), '-d', dir], { quiet: true })
  syncWeb(path.join(dir, 'assets'))
  writeEntry(path.join(dir, 'assets'))
  shrinkFavicon(path.join(dir, 'assets'))
  const tools = findApkTools()
  const raw = path.join(WORK, 'raw.apk')
  const aligned = path.join(WORK, 'aligned.apk')
  const out = path.join(DIST, PKG.apk.file)
  fs.rmSync(raw, { force: true }); fs.rmSync(aligned, { force: true }); fs.rmSync(out, { force: true })
  const cwd = process.cwd()
  process.chdir(dir)
  try { run('zip', ['-q', '-r', '-X', raw, '.'], { quiet: true }) } finally { process.chdir(cwd) }
  run(path.join(tools, 'zipalign'), ['-f', '-p', '4', raw, aligned], { quiet: true })
  run(path.join(tools, 'apksigner'), [
    'sign',
    '--ks', path.join(os.homedir(), '.android', 'debug.keystore'),
    '--ks-pass', 'pass:android',
    '--key-pass', 'pass:android',
    '--ks-key-alias', 'androiddebugkey',
    '--min-sdk-version', '21',
    '--out', out, aligned
  ], { quiet: true })
  run(path.join(tools, 'apksigner'), ['verify', '--verbose', out], { quiet: true }) // 失败会抛
  return out
}

function buildDeb() {
  const dir = path.join(WORK, 'deb')
  run('dpkg-deb', ['-x', path.join(BASE, PKG.deb.file), dir], { quiet: true })
  const ctl = path.join(dir, 'DEBIAN')
  fs.rmSync(ctl, { recursive: true, force: true })
  fs.mkdirSync(ctl, { recursive: true })
  run('dpkg-deb', ['-e', path.join(BASE, PKG.deb.file), ctl], { quiet: true })
  // 版本号递增（deb 是网页壳，只改版本方便用户发现更新）
  const ctlFile = path.join(ctl, 'control')
  const txt = fs.readFileSync(ctlFile, 'utf8')
  const m = txt.match(/^Version:\s*(.+)$/m)
  let ver = m ? m[1].trim() : '1.0'
  // 模板版本可能比 dist 里现成的旧，取大的那个再递增
  const distDeb = path.join(DIST, PKG.deb.file)
  if (fs.existsSync(distDeb)) {
    try {
      const v2 = (run('dpkg-deb', ['-f', distDeb, 'Version'], { quiet: true }) || '').trim()
      if (v2 && v2.localeCompare(ver, undefined, { numeric: true }) > 0) ver = v2
    } catch {}
  }
  const parts = ver.split('.')
  parts[parts.length - 1] = String((parseInt(parts[parts.length - 1], 10) || 0) + 1)
  ver = parts.join('.')
  fs.writeFileSync(ctlFile, txt.replace(/^Version:\s*(.+)$/m, 'Version: ' + ver))
  // 网页壳不含 html，只有 app.py，顺手语法自检一下
  run('python3', ['-c', 'compile(open("' + path.join(dir, 'usr/share/snake-game/app.py') + '").read(),"a.py","exec")'], { quiet: true })
  fs.chmodSync(path.join(dir, 'usr/bin/snake-game'), 0o755)
  const out = path.join(DIST, PKG.deb.file)
  fs.rmSync(out, { force: true })
  run('dpkg-deb', ['--build', '--root-owner-group', dir, out], { quiet: true })
  log(`  deb 版本 ${ver}`)
  return out
}

// ---------- 4. 复制成英文名，供 gh 上传 ----------
const REPO = 's2ys9jgn4d-star/snake-online'

function stageRelease(files) {
  fs.mkdirSync(REL, { recursive: true })
  for (const [k, f] of Object.entries(files)) fs.copyFileSync(f, path.join(REL, PKG[k].out))
}

function latestTag() {
  try { return run('gh', ['release', 'view', '-R', REPO, '--json', 'tagName', '-q', '.tagName'], { quiet: true }) }
  catch { return null }
}

function ensureRelease(tag, files) {
  let exists = true
  try { run('gh', ['release', 'view', tag, '-R', REPO], { quiet: true }) } catch { exists = false }
  if (!exists) {
    const list = Object.values(PKG).map((p) => `- ${p.out}`).join('\n')
    run('gh', ['release', 'create', tag, '-R', REPO,
      '--title', `联机贪吃蛇 ${tag} · 全平台`,
      '--notes', `自动打包产物（${new Date().toLocaleString('zh-CN')}）\n\n${list}`,
      '--latest'], { quiet: true })
    log(`  已新建 Release ${tag}`)
  }
  const assets = Object.keys(files).map((k) => path.join(REL, PKG[k].out))
  run('gh', ['release', 'upload', tag, '-R', REPO, ...assets, '--clobber'], { quiet: true })
  log(`  已上传到 Release ${tag}`)
}

// ---------- 5. 提交并推送 ----------
function gitShip() {
  const isRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
  if (isRepo.status !== 0) { log('  跳过 git：当前目录不是仓库'); return }
  run('git', ['add', 'dist', '打包.js', 'package.json', '.gitignore', 'LICENSE', 'mail.js', 'ios/SnakeOnline/Info.plist'], { quiet: true })
  const diff = spawnSync('git', ['diff', '--cached', '--quiet'])
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const msg = `重新打包全平台安装包 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (diff.status !== 0) {
    run('git', ['-c', 'user.name=niemac13', '-c', 'user.email=niemac13@users.noreply.github.com', 'commit', '-q', '-m', msg], { quiet: true })
    log('  已提交：' + msg)
  } else {
    log('  内容没变化，跳过提交')
  }
  const br = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }) || 'main'
  run('git', ['push', '-q', 'origin', `HEAD:${br}`], { quiet: true })
  log(`  已推送到 origin/${br}`)
}

// ---------- 6. 主流程 ----------
function arg(name, def) {
  const i = process.argv.indexOf(name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

function main() {
  const only = arg('--only', null)
  const wantTag = arg('--tag', null)
  const noUpload = !!arg('--no-upload', false)
  const noGit = !!arg('--no-push', false)

  log(`工作目录 ${WORK}`)
  log('1/5 准备模板包')
  ensureBase()

  log(`2/5 换网页资源（${WEB_FILES.length} 个文件）`)
  for (const f of WEB_FILES) if (!fs.existsSync(path.join(DIST, f))) throw new Error('dist 缺 ' + f)

  log('3/5 重新打包')
  const files = {}
  const which = only ? String(only).split(',') : Object.keys(PKG)
  const builders = { win: buildWin, ipa: buildIpa, dmg: buildDmg, apk: buildApk, deb: buildDeb }
  for (const k of which) {
    if (!builders[k]) throw new Error('不认识的包：' + k)
    const t0 = Date.now()
    files[k] = builders[k]()
    log(`  ${PKG[k].file}  ${sizeOf(files[k])} 字节 (${mb(sizeOf(files[k]))})  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }

  log('4/5 输出英文名到 release/')
  stageRelease(files)

  if (!noUpload) {
    const tag = wantTag && wantTag !== true ? String(wantTag) : (latestTag() || 'v1.0.0')
    log(`5/5 上传 GitHub Release ${tag}`)
    ensureRelease(tag, files)
  } else log('5/5 --no-upload，跳过上传')

  if (!noGit) {
    log('附加：提交并推送仓库')
    gitShip()
  }
  log('完成：dist/ 与 release/ 已更新')
}

try { main() } catch (e) { console.error('打包失败：' + e.message); process.exit(1) }
