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

function applyCors(headers, origin) {
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin");
}

export function middleware(request) {
  const origin = request.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.has(origin);

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
  matcher: ["/api/auth/:path*", "/api/tool/:path*"],
};
