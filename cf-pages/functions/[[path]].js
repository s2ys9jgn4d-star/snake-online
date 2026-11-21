// 兜底路由：只有 WebSocket 升级请求才转发给 Worker，其余交给静态资源
// （前端连接地址是 wss://<host> 根路径，所以根路径也得能升级）
const UPSTREAM = 'https://snake-online.v5tn94ck76.workers.dev/ws';

export async function onRequest(context){
  const upgrade = (context.request.headers.get('Upgrade') || '').toLowerCase();
  if (upgrade !== 'websocket') return context.next();
  const resp = await fetch(UPSTREAM, { headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' } });
  const socket = resp.webSocket;
  if (!socket) return new Response('upstream refused websocket: ' + resp.status, { status: 502 });
  return new Response(null, { status: 101, webSocket: socket });
}
