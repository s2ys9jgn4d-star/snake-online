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

// ---------- 3. 五个包 ----------
function buildWin() {
  const dir = path.join(WORK, 'win')
  run('unzip', ['-q', path.join(BASE, PKG.win.file), '-d', dir], { quiet: true })
  syncWeb(path.join(dir, 'Snake-win64', 'html'))
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
  run('git', ['add', 'dist', '打包.js', 'package.json', '.gitignore'], { quiet: true })
  const diff = spawnSync('git', ['diff', '--cached', '--quiet'])
  const msg = `重新打包全平台安装包 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
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
