import { randomBytes } from "node:crypto";
import { authUrl, oauthStateCookieName, providerConfigured } from "../../_shared.js";

function redirectHome(request, status) {
  const url = new URL("/", request.url);
  url.searchParams.set("auth", status);
  return Response.redirect(url);
}

export async function GET(request, { params }) {
  const { provider } = await params;
  const requestUrl = new URL(request.url);
  const configuredSite = (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (configuredSite) {
    const canonical = new URL(configuredSite);
    if (requestUrl.host !== canonical.host) {
      const target = new URL(requestUrl.pathname + requestUrl.search, canonical.origin);
      return Response.redirect(target);
    }
  }
  if (!providerConfigured(provider)) return redirectHome(request, provider + "_not_configured");
  const state = provider + ":" + randomBytes(18).toString("base64url");
  const url = authUrl(provider, request, state);
  if (!url) return redirectHome(request, "unsupported_provider");
  const response = Response.redirect(url);
  response.headers.append("Set-Cookie", `${oauthStateCookieName()}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  return response;
}
