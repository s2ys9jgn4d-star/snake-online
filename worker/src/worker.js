'use strict';
/*
 * Worker 入口：只负责路由。
 * - WebSocket 与 /api/* 全部转给单个 Durable Object（游戏世界 + 账号 + 排行榜）
 * - 其余请求交给静态资源绑定（dist 目录）
 */
export { Hub } from './hub.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function jsonResponse(code, obj){
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();

    if (request.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const isWebSocket = upgrade === 'websocket';
    const isApi = url.pathname.startsWith('/api/');

    if (isWebSocket || isApi){
      const stub = env.HUB.get(env.HUB.idFromName('global'));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};
