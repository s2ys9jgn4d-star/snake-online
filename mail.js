'use strict';
/*
 * 极简 SMTP 发信（零依赖，只用 Node 内置的 net / tls）
 * 只做一件事：发一封纯文本邮件。
 *
 * 用环境变量配置，哪个邮箱都行：
 *   MAIL_PROVIDER = 126 | 163 | qq | hotmail | outlook | gmail   （自动填服务器地址）
 *   MAIL_USER     = 你的邮箱地址，例如 xiaoming@126.com
 *   MAIL_PASS     = 邮箱的「SMTP 授权码 / 应用专用密码」（不是登录密码！）
 * 也可以手动指定：MAIL_HOST / MAIL_PORT / MAIL_SECURE / MAIL_FROM
 *
 * 注意：Railway 免费/试用套餐封了出站 SMTP（25/465/587），所以线上请用 HTTPS 接口：
 *   MAIL_API     = smtp2go | brevo | resend | mailjet   （走 443 端口，不会被封）
 *   MAIL_API_KEY = 对应平台给你的 API Key（Mailjet 写成「APIKey:SecretKey」）
 *   MAIL_FROM    = 已验证的发件邮箱
 *
 * 想配第二个备用邮箱？把上面 4 个变量改成 MAIL1_ 开头就行：
 *   MAIL1_PROVIDER / MAIL1_USER / MAIL1_PASS / MAIL1_FROM
 * 发送顺序：HTTPS 接口 → MAIL_* → MAIL1_* → MAIL2_*，前一个失败自动换下一个（失败原因写进日志）
 *
 * 126 / 163 / QQ 用 465 端口（一连接就加密）
 * Hotmail / Outlook 用 587 端口（先明文连接，再 STARTTLS 升级加密）
 */
const net = require('net');
const tls = require('tls');

const PROVIDERS = {
  qq:      { host:'smtp.qq.com',           port:465, secure:true  },
  '126':   { host:'smtp.126.com',          port:465, secure:true  },
  '163':   { host:'smtp.163.com',          port:465, secure:true  },
  hotmail: { host:'smtp-mail.outlook.com', port:587, secure:false },
  outlook: { host:'smtp-mail.outlook.com', port:587, secure:false },
  gmail:   { host:'smtp.gmail.com',        port:465, secure:true  }
};

// 一组变量前缀 = 一个发件邮箱，按顺序尝试
const ACCOUNT_PREFIXES = ['MAIL', 'MAIL1', 'MAIL2'];

function readConfig(prefix){
  const get = k => process.env[prefix + '_' + k] || '';
  const preset = PROVIDERS[String(get('PROVIDER')).toLowerCase()] || null;
  const user = get('USER');
  return {
    host: get('HOST') || (preset ? preset.host : ''),
    port: Number(get('PORT') || (preset ? preset.port : 465)),
    secure: get('SECURE') ? get('SECURE') !== '0' : (preset ? preset.secure : true),
    user,
    pass: get('PASS'),
    from: get('FROM') || user
  };
}

// 取出所有填齐了 host / user / pass 的邮箱（重复的邮箱只留第一个）
function accounts(){
  const seen = new Set();
  const list = [];
  for (const p of ACCOUNT_PREFIXES){
    const c = readConfig(p);
    if (!c.host || !c.user || !c.pass) continue;
    const key = c.user.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(c);
  }
  return list;
}

function isConfigured(){
  return !!apiConfig() || accounts().length > 0;
}

// —— HTTPS 发信接口（Railway 这类封 SMTP 的环境用）——
const API_ENDPOINTS = {
  brevo:    'https://api.brevo.com/v3/smtp/email',
  resend:   'https://api.resend.com/emails',
  mailjet:  'https://api.mailjet.com/v3.1/send',
  smtp2go:  'https://api.smtp2go.com/v3/email/send'
};

function apiConfig(){
  const api = String(process.env.MAIL_API || '').toLowerCase();
  const key = process.env.MAIL_API_KEY || '';
  const from = process.env.MAIL_FROM || process.env.MAIL_USER || '';
  if (!API_ENDPOINTS[api] || !key || !from) return null;
  return { api, key, from, url: process.env.MAIL_API_URL || API_ENDPOINTS[api] };
}

async function sendViaApi(c, { to, subject, text }){
  const from = '联机贪吃蛇 <' + c.from + '>';
  let body, headers;
  if (c.api === 'brevo'){
    body = { sender: { email: c.from, name: '联机贪吃蛇' }, to: [{ email: to }], subject, textContent: text };
    headers = { 'api-key': c.key, 'content-type': 'application/json', accept: 'application/json' };
  } else if (c.api === 'resend'){
    body = { from, to: [to], subject, text };
    headers = { authorization: 'Bearer ' + c.key, 'content-type': 'application/json' };
  } else if (c.api === 'mailjet'){
    // Mailjet 要两个密钥：MAIL_API_KEY 写成「API Key:Secret Key」
    const pair = String(c.key).split(':');
    if (pair.length < 2 || !pair[0] || !pair[1]) throw new Error('MAIL_API_KEY 要写成「APIKey:SecretKey」两段，用冒号隔开');
    body = {
      Messages: [{
        From: { Email: c.from, Name: '联机贪吃蛇' },
        To: [{ Email: to }],
        Subject: subject,
        TextPart: text
      }]
    };
    headers = {
      authorization: 'Basic ' + Buffer.from(pair[0] + ':' + pair[1]).toString('base64'),
      'content-type': 'application/json'
    };
  } else {  // smtp2go
    body = { api_key: c.key, sender: from, to: [to], subject, text_body: text };
    headers = { 'content-type': 'application/json' };
  }
  const r = await fetch(c.url, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const raw = await r.text().catch(() => '');
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + raw.slice(0, 200));
  // Mailjet 出错时也可能返回 200，要看 Messages[0].Status
  if (c.api === 'mailjet'){
    let d = null;
    try { d = JSON.parse(raw); } catch {}
    const st = d && d.Messages && d.Messages[0] && d.Messages[0].Status;
    if (st !== 'success') throw new Error('接口没发出去：' + raw.slice(0, 200));
  }
  // SMTP2GO 出错时也返回 200，要看 data.failed / data.succeeded
  if (c.api === 'smtp2go'){
    let d = null;
    try { d = JSON.parse(raw); } catch {}
    const data = (d && d.data) || {};
    if (!(data.succeeded > 0)) throw new Error('接口没发出去：' + raw.slice(0, 200));
  }
}

// 把 socket 包成「能按行收发」的小工具
function attach(sock){
  const st = { buf:'', queue:[], waiter:null };
  sock.setEncoding('utf8');
  sock.on('data', chunk => {
    st.buf += chunk;
    let i;
    while ((i = st.buf.indexOf('\r\n')) >= 0){
      const line = st.buf.slice(0, i);
      st.buf = st.buf.slice(i + 2);
      // SMTP 多行响应形如 "250-xxx"，最后一行是 "250 xxx"（数字后是空格）
      if (/^\d{3} /.test(line)){
        const res = { code: Number(line.slice(0, 3)), text: line };
        if (st.waiter){ const w = st.waiter; st.waiter = null; w.resolve(res); }
        else st.queue.push(res);   // 服务器可能比我们先说话，先排队
      }
    }
  });
  const fail = err => {
    if (st.waiter){ const w = st.waiter; st.waiter = null; w.reject(err); }
  };
  sock.on('error', fail);
  sock.on('close', () => fail(new Error('SMTP 连接被关闭')));
  st.read = () => st.queue.length
    ? Promise.resolve(st.queue.shift())
    : new Promise((resolve, reject) => { st.waiter = { resolve, reject }; });
  st.cmd = line => { sock.write(line + '\r\n'); return st.read(); };
  st.write = s => sock.write(s);
  return st;
}

// 587 端口：明文连上之后升级成 TLS
function startTls(sock, host){
  return new Promise((resolve, reject) => {
    const opts = { socket: sock };
    if (!net.isIP(host)) opts.servername = host;
    const s = tls.connect(opts);
    s.once('secureConnect', () => resolve(attach(s)));
    s.once('error', reject);
  });
}

function b64(s){ return Buffer.from(String(s), 'utf8').toString('base64'); }

// base64 正文要按 76 字符折行，否则有些服务器会报格式错误
function wrap76(s){
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join('\r\n');
}

function buildMessage(c, { to, subject, text }){
  return [
    'Date: ' + new Date().toUTCString(),
    'From: =?UTF-8?B?' + b64('联机贪吃蛇') + '?= <' + c.from + '>',
    'To: <' + to + '>',
    'Subject: =?UTF-8?B?' + b64(subject) + '?=',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text)),
    ''
  ].join('\r\n');
}

// 用指定的一个邮箱发一封
async function sendOne(c, { to, subject, text }){
  const tlsOpts = { host: c.host, port: c.port };
  if (!net.isIP(c.host)) tlsOpts.servername = c.host;   // 直接写 IP 时不能带 servername
  let sock = c.secure ? tls.connect(tlsOpts) : net.connect(c.port, c.host);
  sock.setTimeout(5000, () => sock.destroy(new Error('SMTP 超时（5 秒）')));

  await new Promise((resolve, reject) => {
    sock.once(c.secure ? 'secureConnect' : 'connect', resolve);
    sock.once('error', reject);
  });

  let r = attach(sock);
  const check = (res, label) => {
    if (res.code >= 400) throw new Error(label + '失败：' + res.text);
    return res;
  };

  try {
    check(await r.read(), '连接');                       // 220 欢迎语
    check(await r.cmd('EHLO localhost'), 'EHLO');
    if (!c.secure){
      check(await r.cmd('STARTTLS'), 'STARTTLS');
      sock.removeAllListeners('data');
      r = await startTls(sock, c.host);
      check(await r.cmd('EHLO localhost'), 'EHLO(TLS)');
    }
    const a1 = await r.cmd('AUTH LOGIN');
    if (a1.code !== 334) throw new Error('服务器不支持账号密码登录：' + a1.text);
    const a2 = await r.cmd(b64(c.user));
    if (a2.code !== 334) throw new Error('账号被拒绝：' + a2.text);
    const a3 = await r.cmd(b64(c.pass));
    if (a3.code !== 235) throw new Error('授权码不对：' + a3.text);
    check(await r.cmd('MAIL FROM:<' + c.from + '>'), 'MAIL FROM');
    check(await r.cmd('RCPT TO:<' + to + '>'), 'RCPT TO');
    const d = await r.cmd('DATA');
    if (d.code !== 354) throw new Error('DATA 失败：' + d.text);
    r.write(buildMessage(c, { to, subject, text }) + '\r\n.\r\n');
    check(await r.read(), '发送正文');
    try { r.write('QUIT\r\n'); } catch {}
  } finally {
    try { sock.end(); } catch {}
  }
}

// 按顺序试每个发信方式，前一个失败就换下一个
async function sendMail(opts){
  const tryList = [];
  const api = apiConfig();
  if (api) tryList.push({ name: '接口(' + api.api + ')', run: () => sendViaApi(api, opts) });
  for (const c of accounts()) tryList.push({ name: c.user, run: () => sendOne(c, opts) });
  if (!tryList.length) throw new Error('服务器还没配置邮箱服务');

  const errs = [];
  for (let i = 0; i < tryList.length; i++){
    try {
      await tryList[i].run();
      return;
    } catch (e){
      errs.push(tryList[i].name + '：' + e.message);
      const more = i + 1 < tryList.length;
      console.log('[mail] ' + tryList[i].name + ' 发送失败' + (more ? '，换下一个方式重试' : '，没有备用方式了') + ' → ' + e.message);
    }
  }
  throw new Error(errs.join('；'));
}

module.exports = { sendMail, isConfigured, accounts, apiConfig };
