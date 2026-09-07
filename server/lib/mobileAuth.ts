import { timingSafeEqual } from "node:crypto";

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeMobile(request: Request): Response | null {
  const expected = process.env.MOBILE_API_TOKEN?.trim();
  if (!expected) {
    return Response.json({ error: "手机访问尚未配置" }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const actual = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!actual || !equalSecret(actual, expected)) {
    return Response.json({ error: "手机身份验证失败" }, { status: 401 });
  }
  return null;
}

