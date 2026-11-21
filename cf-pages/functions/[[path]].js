// 这一层只做「转发壳」：浏览器连 pages.dev（国内能通），
// 页面、接口、WebSocket 全部交给那个 Worker。这样只要 GitHub 推代码、
// Workers 构建重新部署，整站（含静态页）就一起更新，Pages 这边不用再发。
const WORKER = 'https://snake-online.v5tn94ck76.workers.dev';

async function proxyWebSocket(){
  const resp = await fetch(WORKER + '/ws', {
    headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' }
  });
  const socket = resp.webSocket;
  if (!socket) return new Response('upstream refused websocket: ' + resp.status, { status: 502 });
  return new Response(null, { status: 101, webSocket: socket });
}

export async function onRequest(context){
  const req = context.request;
  const upgrade = (req.headers.get('Upgrade') || '').toLowerCase();
  if (upgrade === 'websocket') return proxyWebSocket();

  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete('host');
  const init = { method: req.method, headers, redirect: 'manual' };
  if (req.method !== 'GET' && req.method !== 'HEAD'){
    init.body = await req.arrayBuffer();
  }
  const target = url.pathname === '/' ? '/index.html' : url.pathname;
  const resp = await fetch(WORKER + target + url.search, init);
  // 直接把上游的 body / 头 / 状态码原样吐回去
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
}
