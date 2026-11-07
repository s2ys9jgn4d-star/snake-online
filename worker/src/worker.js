'use strict';
/*
 * Worker 入口：只负责路由，全部游戏状态在单个 Durable Object 里。
 * 静态页面由 Cloudflare Pages 托管，这里不提供静态文件。
 */
export { Hub } from './hub.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// 路径 -> 方法（与原版 API 一致）
const API_ROUTES = {
  '/api/register': 'POST',
  '/api/login': 'POST',
  '/api/logout': 'POST',
  '/api/delete-account': 'POST',
  '/api/me': 'GET',
  '/api/scores': 'GET'
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
    const apiMethod = API_ROUTES[url.pathname];
    const isApi = apiMethod && request.method === apiMethod;

    if (isWebSocket || isApi){
      const stub = env.HUB.get(env.HUB.idFromName('global'));
      return stub.fetch(request);
    }

    return jsonResponse(404, { error: 'not found' });
  }
};
