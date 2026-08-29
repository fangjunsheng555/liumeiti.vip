import { NextResponse } from "next/server";

// tool.liumeiti.vip is limited to /api/tool/* plus the read-only account
// identity endpoint. Account mutations, money, orders and admin APIs remain
// same-origin-only. The apex and www storefronts intentionally coexist, so
// exact cross-host requests between those two trusted origins are accepted.

const ALLOWED_TOOL_ORIGINS = new Set(
  [
    "https://tool.liumeiti.vip",
    process.env.TOOL_ORIGIN || "",
    ...(process.env.NODE_ENV !== "production"
      ? ["http://localhost:8799", "http://localhost:3000", "http://127.0.0.1:8799"]
      : []),
  ].filter(Boolean)
);

const TRUSTED_MAIN_SITE_ORIGINS = new Set([
  "https://liumeiti.vip",
  "https://www.liumeiti.vip",
]);

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

// The tool site runs on the main site's account system: one session cookie,
// issued here, scoped to .liumeiti.vip. Its cross-origin surface is exactly
// the endpoints its account client calls, method by method — identity stays
// read-only, sign-in/out, and the register/recover trio. None of these act on
// an existing session (sign-out at worst signs the caller out), and the origin
// allowlist is exact, so this is not a CSRF surface. Everything that moves
// money or touches orders remains same-origin-only.
const TOOL_ACCOUNT_API_METHODS = new Map([
  ["/api/auth/me", ["GET", "HEAD"]],
  ["/api/auth/login", ["POST", "DELETE"]],
  ["/api/auth/captcha", ["GET"]],
  ["/api/auth/register", ["POST"]],
  ["/api/auth/forgot", ["POST"]],
  ["/api/auth/reset", ["POST"]],
]);

function toolAccountApiMethods(pathname) {
  return TOOL_ACCOUNT_API_METHODS.get(pathname) || null;
}

function isToolAccountApiPath(pathname, method) {
  const allowed = toolAccountApiMethods(pathname);
  if (!allowed) return false;
  const normalized = String(method || "GET").toUpperCase();
  return normalized === "OPTIONS" || allowed.includes(normalized);
}

function isProtectedCookieApiPath(pathname) {
  return pathname === "/api/order"
    || pathname === "/api/order-query"
    || pathname === "/api/quote-orders"
    || pathname.startsWith("/api/quote-orders/")
    || pathname === "/api/account"
    || pathname.startsWith("/api/account/")
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

function isTrustedMainSiteBridge(request, origin) {
  return Boolean(
    origin
    && origin !== request.nextUrl.origin
    && TRUSTED_MAIN_SITE_ORIGINS.has(origin)
    && TRUSTED_MAIN_SITE_ORIGINS.has(request.nextUrl.origin)
  );
}

function isAllowedCookieApiOrigin(request, origin) {
  if (origin) return origin === request.nextUrl.origin || isTrustedMainSiteBridge(request, origin);
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
// 验签仍由各路由做)。吊销存储异常默认记录告警并 fail-open，避免后台整体锁死；
// 只有明确读到且命中踢出边界才 401。ADMIN_KICK_CHECK_FAIL_CLOSED=1 可改为严格模式。
// 精确的 /api/admin/login 不做中间件检查，避免旧 cookie 阻断新凭据登录。
function adminSessionStoreUnavailableResponse() {
  return NextResponse.json({ ok: false, error: "session_store_unavailable" }, {
    status: 503,
    headers: { "Cache-Control": "no-store", "Retry-After": "5" },
  });
}

function adminKickCheckUnavailable(reason) {
  // Hosting runtime logs provide an observable warning without exposing the
  // cookie, staff identity, Redis URL, token or response body.
  console.warn(JSON.stringify({
    level: "warn",
    event: "admin_session_revocation_check_unavailable",
    reason,
  }));
  return process.env.ADMIN_KICK_CHECK_FAIL_CLOSED === "1"
    ? adminSessionStoreUnavailableResponse()
    : null;
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
    // Route handlers still verify signatures and permissions. This lookup only
    // accelerates revocation, so outages default to availability-first. An
    // explicit switch remains available for operators that require fail-close.
    if (!url || !key) return adminKickCheckUnavailable("redis_configuration_missing");
    const res = await fetch(`${url.replace(/\/$/, "")}/get/${encodeURIComponent("lm:staff:kick:" + staffId)}`, {
      headers: { Authorization: "Bearer " + key },
    });
    if (!res.ok) return adminKickCheckUnavailable("redis_http_error");
    const stored = await res.json();
    if (!stored || typeof stored !== "object" || stored.error || !("result" in stored)) {
      return adminKickCheckUnavailable("redis_response_invalid");
    }
    if (stored.result == null) return null;
    const kickTs = Number(stored.result);
    if (!Number.isSafeInteger(kickTs) || kickTs < 0) {
      return adminKickCheckUnavailable("revocation_record_invalid");
    }
    if (!kickTs) return null;
    const iat = Number(payload?.iat || 0);
    // Only a valid issued-at value at/before a valid stored boundary is an
    // explicit revocation hit. Malformed JWTs are left to the signed route
    // verifier instead of being interpreted as revoked here.
    if (!Number.isSafeInteger(iat) || iat <= 0) return null;
    if (Number.isSafeInteger(iat) && iat > kickTs) return null; // 踢出后重新登录的新会话有效
    // 已被强制下线:清 cookie + 401
    const out = NextResponse.json({ ok: false, error: "session_revoked" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
    out.cookies.set("lm_admin", "", { path: "/", maxAge: 0 });
    return out;
  } catch (e) { return adminKickCheckUnavailable("redis_request_failed"); }
}

export async function proxy(request) {
  const origin = request.headers.get("origin") || "";
  const { pathname } = request.nextUrl;
  const toolApi = isToolApiPath(pathname);
  const toolAccountApi = isToolAccountApiPath(pathname, request.method);
  const toolCorsSurface = toolApi || toolAccountApi;
  const allowToolCors = toolCorsSurface && ALLOWED_TOOL_ORIGINS.has(origin);
  const allowMainSiteBridgeCors = isTrustedMainSiteBridge(request, origin);

  // A sibling subdomain is same-site for SameSite cookies, so cookie flags do
  // not stop it from issuing credentialed requests to the main host. Reject
  // non-same-origin browser requests before any admin/auth/funds route runs.
  if (
    isProtectedCookieApiPath(pathname)
    && !allowToolCors
    && !isAllowedCookieApiOrigin(request, origin)
  ) {
    return forbiddenOriginResponse();
  }

  // Tool APIs are the only cross-origin surface. Unknown, null and lookalike
  // origins receive neither a permissive preflight nor readable responses.
  if (toolCorsSurface && origin && !allowToolCors && !allowMainSiteBridgeCors) {
    return forbiddenOriginResponse();
  }

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
  if (request.method === "OPTIONS" && (allowToolCors || allowMainSiteBridgeCors)) {
    const headers = new Headers();
    applyCors(headers, origin);
    // An account path advertises exactly its own allowed methods; the wider
    // list is reserved for the /api/tool/* surface.
    const accountMethods = toolAccountApi ? toolAccountApiMethods(pathname) : null;
    headers.set("Access-Control-Allow-Methods", accountMethods
      ? accountMethods.concat("OPTIONS").join(",")
      : "GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS");
    const requestedHeaders = request.headers.get("access-control-request-headers") || "Content-Type";
    headers.set("Access-Control-Allow-Headers", requestedHeaders);
    headers.set("Access-Control-Max-Age", "86400");
    return new NextResponse(null, { status: 204, headers });
  }

  const res = NextResponse.next();
  if (allowToolCors || allowMainSiteBridgeCors) applyCors(res.headers, origin);
  return res;
}

export const config = {
  matcher: [
    "/services/:path*",
    "/api/auth/:path*",
    "/api/account/:path*",
    "/api/tool/:path*",
    "/api/order",
    "/api/order-query",
    "/api/quote-orders/:path*",
    "/api/track",
    "/api/admin/:path*",
    "/api/netflix-code",
    "/api/test-email",
  ],
};
