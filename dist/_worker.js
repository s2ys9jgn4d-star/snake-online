/**
 * Cloudflare Pages 高级模式入口。
 * 静态文件由 Pages 从本仓库 dist/ 提供（push 即更新），
 * /api 与 /ws 实时反代到 Railway 后端，避免静态副本与后端版本不一致。
 */
const ORIGIN = 'https://snake-online.up.railway.app';

const PROXY_PREFIXES = ['/api', '/ws'];

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade-insecure-requests',
  'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor', 'cf-ew-via',
  'cdn-loop', 'x-real-ip', 'host'
];

function isProxyPath(pathname) {
  return PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function buildUpstreamRequest(request, url) {
  const target = new URL(url.pathname + url.search, ORIGIN);
  const headers = new Headers(request.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  const hasBody = !(request.method === 'GET' || request.method === 'HEAD');
  return new Request(target.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
    // 让 Worker 能接管 WebSocket 握手
    ...(request.headers.get('upgrade') ? { duplex: 'half' } : {})
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!isProxyPath(url.pathname)) {
      if (!env || !env.ASSETS) {
        return new Response('静态资源未配置：请在 Pages 项目里把输出目录指向 dist/', { status: 500 });
      }
      return env.ASSETS.fetch(request);
    }

    let upstream;
    try {
      upstream = await fetch(buildUpstreamRequest(request, url));
    } catch (err) {
      return new Response('后端暂时连不上，请稍后再试', {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      });
    }

    // WebSocket：直接把带 webSocket 的响应交还给浏览器
    if (upstream.webSocket) {
      return new Response(null, { status: 101, webSocket: upstream.webSocket });
    }

    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete('content-encoding');
    outHeaders.delete('content-length');
    outHeaders.delete('transfer-encoding');
    outHeaders.delete('connection');
    const passthrough = request.method === 'HEAD' ? null : upstream.body;
    return new Response(passthrough, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders
    });
  }
};
