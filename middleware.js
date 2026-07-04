// CORS for cross-origin (same-site) calls from the tools site.
// tool.liumeiti.vip and liumeiti.vip share the registrable domain, so the
// lm_user session cookie (SameSite=Lax, host-only) is still sent on these
// fetches with credentials:'include'. We only add CORS headers when the Origin
// is an explicitly allowed tool origin — same-origin main-site calls are
// untouched. Additive: no existing route is modified.

import { NextResponse } from "next/server";

const ALLOWED_ORIGINS = new Set(
  [
    "https://tool.liumeiti.vip",
    process.env.TOOL_ORIGIN || "",
    ...(process.env.NODE_ENV !== "production"
      ? ["http://localhost:8799", "http://localhost:3000", "http://127.0.0.1:8799"]
      : []),
  ].filter(Boolean)
);

const SERVICE_CANONICAL_SLUGS = new Set(["spotify", "ai", "netflix", "disney", "hbo-max", "airport-node"]);
const SERVICE_SLUG_REDIRECTS = {
  max: "hbo-max",
  hbomax: "hbo-max",
  rocket: "airport-node",
};

function applyCors(headers, origin) {
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
}

function handleServiceSlug(request, pathname) {
  const match = pathname.match(/^\/services\/([^/]+)\/?$/);
  if (!match) return null;

  let slug = "";
  try {
    slug = decodeURIComponent(match[1]).toLowerCase();
  } catch (e) {
    slug = String(match[1] || "").toLowerCase();
  }

  const canonical = SERVICE_SLUG_REDIRECTS[slug];
  if (canonical) {
    const url = request.nextUrl.clone();
    url.pathname = `/services/${canonical}`;
    return NextResponse.redirect(url, 308);
  }

  if (SERVICE_CANONICAL_SLUGS.has(slug)) return null;

  return new NextResponse(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex,follow"><title>404 - Page not found</title></head><body>404 - Page not found</body></html>',
    {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Robots-Tag": "noindex, follow",
      },
    }
  );
}

// ── 后台会话强制下线检查 ──
// 会话是无状态 JWT;「踢下线」通过 lm:staff:kick:<id>(毫秒时间戳)实现:
// 签发时间(iat)早于踢出时间的会话一律 401。这里只做吊销检查(解析 payload 不验签,
// 验签仍由各路由做;伪造 payload 最多让自己被 401,无危害)。Redis 出错时放行(fail-open,
// 避免 Redis 抖动把站主锁在门外)。/api/admin/login 除外(带着旧 cookie 也要能重新登录/登出)。
async function adminKickCheck(request) {
  try {
    const token = request.cookies.get("lm_admin")?.value || "";
    if (!token) return null; // 未登录 → 交给路由返回 401
    const data = token.split(".")[0];
    if (!data) return null;
    const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    const staffId = Number(payload?.staffId || 0);
    if (!staffId) return null;
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const key = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !key) return null;
    const res = await fetch(`${url}/get/${encodeURIComponent("lm:staff:kick:" + staffId)}`, {
      headers: { Authorization: "Bearer " + key },
    });
    if (!res.ok) return null;
    const kickTs = Number((await res.json())?.result || 0);
    if (!kickTs) return null;
    const iat = Number(payload?.iat || 0);
    if (iat >= kickTs) return null; // 踢出后重新登录的新会话有效
    // 已被强制下线:清 cookie + 401
    const out = NextResponse.json({ ok: false, error: "session_revoked" }, { status: 401 });
    out.cookies.set("lm_admin", "", { path: "/", maxAge: 0 });
    return out;
  } catch (e) { return null; }
}

export async function middleware(request) {
  const origin = request.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.has(origin);

  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/services/")) {
    const serviceResponse = handleServiceSlug(request, pathname);
    if (serviceResponse) return serviceResponse;
  }

  if (pathname.startsWith("/api/admin") && !pathname.startsWith("/api/admin/login")) {
    const revoked = await adminKickCheck(request);
    if (revoked) return revoked;
  }

  // Preflight: answer here (only for allowed cross-origin requests).
  if (request.method === "OPTIONS" && allow) {
    const headers = new Headers();
    applyCors(headers, origin);
    headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
    return new NextResponse(null, { status: 204, headers });
  }

  const res = NextResponse.next();
  if (allow) applyCors(res.headers, origin);
  return res;
}

export const config = {
  matcher: ["/services/:path*", "/api/auth/:path*", "/api/tool/:path*", "/api/track", "/api/admin/:path*"],
};
