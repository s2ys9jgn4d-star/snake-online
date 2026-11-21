// 所有 /api/* 原样转发给已部署的 Worker（Durable Object 在那边）
const WORKER = 'https://snake-online.v5tn94ck76.workers.dev';

export async function onRequest(context){
  const url = new URL(context.request.url);
  const target = WORKER + url.pathname + url.search;
  const headers = new Headers(context.request.headers);
  headers.delete('host');
  const init = { method: context.request.method, headers, redirect: 'manual' };
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD'){
    init.body = await context.request.arrayBuffer();
  }
  const resp = await fetch(target, init);
  const out = new Headers(resp.headers);
  out.set('Access-Control-Allow-Origin', '*');
  return new Response(resp.body, { status: resp.status, headers: out });
}
