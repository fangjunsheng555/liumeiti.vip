// CORS for cross-origin (same-site) calls from the tools site.
// tool.liumeiti.vip and liumeiti.vip share the registrable domain, so the
// lm_user session cookie (SameSite=Lax, host-only) is still sent on these
// fetches with credentials:'include'. We only add CORS headers when the Origin
// is an explicitly allowed tool origin — same-origin main-site calls are
// untouched. Additive: no existing route is modified.

import { NextResponse } from "next/server";

const ALLOWED_TOOL_ORIGINS = new Set(
  [
    "https://tool.liumeiti.vip",
    process.env.TOOL_ORIGIN || "",
    ...(process.env.NODE_ENV !== "production"
      ? ["http://localhost:8799", "http://localhost:3000", "http://127.0.0.1:8799"]
      : []),
  ].filter(Boolean)
);

const SERVICE_CANONICAL_SLUGS = new Set(["spotify", "ai", "netflix", "disney", "hbo-max", "airport-node", "proxy-payment"]);
const SERVICE_SLUG_REDIRECTS = {
  max: "hbo-max",
  hbomax: "hbo-max",
  rocket: "airport-node",
  "proxy-pay": "proxy-payment",
};

function applyCors(headers, origin) {
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
}

function isToolApiPath(pathname) {
  return pathname === "/api/tool" || pathname.startsWith("/api/tool/");
}

function isProtectedCookieApiPath(pathname) {
  return pathname === "/api/order"
    || pathname === "/api/quote-orders"
    || pathname.startsWith("/api/quote-orders/")
    || pathname.startsWith("/api/auth/")
    || pathname === "/api/admin"
    || pathname.startsWith("/api/admin/")
    || pathname === "/api/netflix-code"
    || pathname === "/api/test-email";
}

function isAdminCookieApiPath(pathname) {
  return pathname === "/api/admin"
    || pathname.startsWith("/api/admin/")
    || pathname === "/api/test-email";
}

function isUnsafeMethod(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

function isSameOriginBrowserRequest(request, origin) {
  if (origin) return origin === request.nextUrl.origin;
  // OAuth callbacks and normal top-level GET navigations may omit Origin.
  // For cookie-authenticated writes, modern browsers still expose their
  // cross-site provenance through Sec-Fetch-Site.
  if (!isUnsafeMethod(request.method)) return true;
  const fetchSite = request.headers.get("sec-fetch-site") || "";
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

function forbiddenOriginResponse() {
  return NextResponse.json({ ok: false, error: "origin_forbidden" }, {
    status: 403,
    headers: { "Cache-Control": "no-store", "Vary": "Origin" },
  });
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
// 签发时间(iat) <= 踢出边界的会话一律 401。这里只做吊销检查(解析 payload 不验签,
// 验签仍由各路由做)。Redis 已配置却读取失败时 fail-closed，避免复制 JWT 绕过撤销。
// 精确的 /api/admin/login 不做中间件检查，由登录路由自身完成同样的 fail-closed
// 存储校验，避免中间件在读取旧 cookie 后阻断新凭据请求。
function adminSessionStoreUnavailableResponse() {
  return NextResponse.json({ ok: false, error: "session_store_unavailable" }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "5" },
  });
}

async function adminKickCheck(request) {
  try {
    const token = request.cookies.get("lm_admin")?.value || "";
    if (!token) return null; // 未登录 → 交给路由返回 401
    const data = token.split(".")[0];
    if (!data) return null;
    let payload = null;
    try {
      const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
      payload = JSON.parse(atob(b64));
    } catch (e) {
      return null; // 格式/签名仍由路由统一返回 unauthorized
    }
    const staffId = Number(payload?.staffId || 0);
    if (!Number.isSafeInteger(staffId) || staffId <= 0) return null;
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const key = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    // A signed admin cookie without its revocation store cannot be considered
    // valid: accepting it would silently restore the old non-revocable JWT
    // behavior after a deployment/configuration failure.
    if (!url && !key) return adminSessionStoreUnavailableResponse();
    if (!url || !key) return adminSessionStoreUnavailableResponse();
    const res = await fetch(`${url.replace(/\/$/, "")}/get/${encodeURIComponent("lm:staff:kick:" + staffId)}`, {
      headers: { Authorization: "Bearer " + key },
    });
    if (!res.ok) return adminSessionStoreUnavailableResponse();
    const stored = await res.json();
    if (!stored || typeof stored !== "object" || stored.error || !("result" in stored)) {
      return adminSessionStoreUnavailableResponse();
    }
    if (stored.result == null) return null;
    const kickTs = Number(stored.result);
    if (!Number.isSafeInteger(kickTs) || kickTs < 0) return adminSessionStoreUnavailableResponse();
    if (!kickTs) return null;
    const iat = Number(payload?.iat || 0);
    if (Number.isSafeInteger(iat) && iat > kickTs) return null; // 踢出后重新登录的新会话有效
    // 已被强制下线:清 cookie + 401
    const out = NextResponse.json({ ok: false, error: "session_revoked" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
    out.cookies.set("lm_admin", "", { path: "/", maxAge: 0 });
    return out;
  } catch (e) { return adminSessionStoreUnavailableResponse(); }
}

export async function middleware(request) {
  const origin = request.headers.get("origin") || "";
  const { pathname } = request.nextUrl;
  const toolApi = isToolApiPath(pathname);
  const allowToolCors = toolApi && ALLOWED_TOOL_ORIGINS.has(origin);

  // A sibling subdomain is same-site for SameSite cookies, so cookie flags do
  // not stop it from issuing credentialed requests to the main host. Reject
  // non-same-origin browser requests before any admin/auth/funds route runs.
  if (isProtectedCookieApiPath(pathname) && !isSameOriginBrowserRequest(request, origin)) {
    return forbiddenOriginResponse();
  }

  // Tool APIs are the only cross-origin surface. Unknown, null and lookalike
  // origins receive neither a permissive preflight nor readable responses.
  if (toolApi && origin && !allowToolCors) return forbiddenOriginResponse();

  if (pathname.startsWith("/services/")) {
    const serviceResponse = handleServiceSlug(request, pathname);
    if (serviceResponse) return serviceResponse;
  }

  const adminLoginPath = pathname === "/api/admin/login" || pathname === "/api/admin/login/";
  if (isAdminCookieApiPath(pathname) && !adminLoginPath) {
    const revoked = await adminKickCheck(request);
    if (revoked) return revoked;
  }

  // Preflight: answer here only for an explicitly allowed tool origin.
  if (request.method === "OPTIONS" && allowToolCors) {
    const headers = new Headers();
    applyCors(headers, origin);
    headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
    return new NextResponse(null, { status: 204, headers });
  }

  const res = NextResponse.next();
  if (allowToolCors) applyCors(res.headers, origin);
  return res;
}

export const config = {
  matcher: [
    "/services/:path*",
    "/api/auth/:path*",
    "/api/tool/:path*",
    "/api/order",
    "/api/quote-orders/:path*",
    "/api/track",
    "/api/admin/:path*",
    "/api/netflix-code",
    "/api/test-email",
  ],
};
