#!/usr/bin/env node
'use strict';
/*
 * 打包源码 tar.gz（零依赖，只用 Node 内置模块）
 * 目录格式仿照 UTM-5.0.8.tar.gz：
 *   snake-online-<版本>/
 *   snake-online-<版本>/server.js
 *   snake-online-<版本>/dist/mobile.html
 *   ...
 *
 * 用法： node 打包tar.js
 * 产物： 安装包/snake-online-<版本>.tar.gz
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const NAME = 'snake-online';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TOP = NAME + '-' + pkg.version;          // 顶层目录名，如 snake-online-2.0.1
const OUT_DIR = path.join(ROOT, '安装包');
const OUT_FILE = path.join(OUT_DIR, TOP + '.tar.gz');

// 这些不需要打进源码包（数据/密钥/构建产物）
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', '安装包', '.wrangler', '.idea', '.vscode']);
const SKIP_FILES = new Set(['.DS_Store', 'snake-downloads.zip', 'package-lock.json']);

// ------------------------------------------------------------
//  1. 收集文件
// ------------------------------------------------------------
function walk(dir, rel, list){
  for (const name of fs.readdirSync(dir).sort()){
    const abs = path.join(dir, name);
    const relPath = rel ? rel + '/' + name : name;
    const st = fs.lstatSync(abs);
    if (st.isDirectory()){
      if (SKIP_DIRS.has(name)) continue;
      list.push({ rel: relPath, dir: true, mtime: st.mtimeMs });
      walk(abs, relPath, list);
    } else if (st.isFile()){
      if (SKIP_FILES.has(name)) continue;
      if (name.endsWith('.tar.gz') || name.endsWith('.idsig')) continue;
      list.push({ rel: relPath, dir: false, size: st.size, mtime: st.mtimeMs });
    }
  }
}

// ------------------------------------------------------------
//  2. 手写 tar（ustar 格式），再 gzip
// ------------------------------------------------------------
function octal(n, len){
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header(name, size, mtimeSec, isDir){
  const buf = Buffer.alloc(512, 0);
  let nameBuf = Buffer.from(name, 'utf8');
  let prefix = '';
  // ustar 名字段只有 100 字节，太长就切到 prefix 字段
  if (nameBuf.length > 100){
    const cut = name.lastIndexOf('/', nameBuf.length - 1);
    prefix = name.slice(0, cut);
    nameBuf = Buffer.from(name.slice(cut + 1), 'utf8');
  }
  nameBuf.copy(buf, 0);
  buf.write(octal(isDir ? 0o755 : 0o644, 8), 100, 8, 'ascii');   // 权限
  buf.write(octal(0, 8), 108, 8, 'ascii');                        // uid
  buf.write(octal(0, 8), 116, 8, 'ascii');                         // gid
  buf.write(octal(isDir ? 0 : size, 12), 124, 12, 'ascii');        // 大小
  buf.write(octal(mtimeSec, 12), 136, 12, 'ascii');                // 修改时间
  buf.write('        ', 148, 8, 'ascii');                          // 校验和占位
  buf.write(isDir ? '5' : '0', 156, 1, 'ascii');                   // 类型
  buf.write('ustar\0' + '00', 257, 8, 'ascii');                    // 格式标识
  if (prefix) buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

function pad512(n){
  const rest = n % 512;
  return rest === 0 ? 0 : 512 - rest;
}

// ------------------------------------------------------------
//  3. 打包
// ------------------------------------------------------------
function main(){
  const items = [{ rel: '', dir: true, mtime: Date.now() }];
  walk(ROOT, '', items);

  const parts = [];
  for (const it of items){
    const fullName = TOP + '/' + it.rel;               // 顶层目录前缀
    const mtimeSec = Math.floor(it.mtime / 1000);
    if (it.dir){
      const name = fullName.endsWith('/') ? fullName : fullName + '/';
      parts.push(header(name, 0, mtimeSec, true));
      continue;
    }
    const data = fs.readFileSync(path.join(ROOT, it.rel));
    parts.push(header(fullName, data.length, mtimeSec, false));
    parts.push(data);
    const p = pad512(data.length);
    if (p) parts.push(Buffer.alloc(p, 0));
  }
  parts.push(Buffer.alloc(1024, 0));                    // 结尾两个全零块

  const tarBuf = Buffer.concat(parts);
  const gz = zlib.gzipSync(tarBuf, { level: 9 });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, gz);

  const files = items.filter(x => !x.dir).length;
  console.log('打包完成：' + path.relative(ROOT, OUT_FILE));
  console.log('顶层目录：' + TOP + '/');
  console.log('文件数量：' + files + ' 个，大小：' + (gz.length / 1024).toFixed(1) + ' KB');
}

main();
