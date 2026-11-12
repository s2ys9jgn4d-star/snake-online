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

function config(){
  const preset = PROVIDERS[String(process.env.MAIL_PROVIDER || '').toLowerCase()] || null;
  const user = process.env.MAIL_USER || '';
  return {
    host: process.env.MAIL_HOST || (preset ? preset.host : ''),
    port: Number(process.env.MAIL_PORT || (preset ? preset.port : 465)),
    secure: process.env.MAIL_SECURE ? process.env.MAIL_SECURE !== '0' : (preset ? preset.secure : true),
    user,
    pass: process.env.MAIL_PASS || '',
    from: process.env.MAIL_FROM || user
  };
}

function isConfigured(){
  const c = config();
  return !!(c.host && c.user && c.pass);
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

async function sendMail({ to, subject, text }){
  const c = config();
  if (!isConfigured()) throw new Error('服务器还没配置邮箱服务');

  const tlsOpts = { host: c.host, port: c.port };
  if (!net.isIP(c.host)) tlsOpts.servername = c.host;   // 直接写 IP 时不能带 servername
  let sock = c.secure ? tls.connect(tlsOpts) : net.connect(c.port, c.host);
  sock.setTimeout(20000, () => sock.destroy(new Error('SMTP 超时（20 秒）')));

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

module.exports = { sendMail, isConfigured, config };
