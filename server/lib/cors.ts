import { NextResponse } from "next/server";

// 插件的 background script 会跨源（chrome-extension://...）调用这个本地服务，需要放开 CORS
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  // Chrome 私有网络访问（PNA）：公网页面上的扩展 iframe 请求 localhost 时，
  // 新版 Chrome 会先发带此标记的预检，不放行可能导致请求被静默挂起
  "Access-Control-Allow-Private-Network": "true",
};

export function withCors(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...CORS_HEADERS, ...(init?.headers ?? {}) },
  });
}

export function corsPreflight() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
