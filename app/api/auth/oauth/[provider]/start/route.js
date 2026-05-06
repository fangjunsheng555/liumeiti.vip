import { randomBytes } from "node:crypto";
import { authUrl, oauthStateCookieName, providerConfigured } from "../../_shared.js";

function redirectHome(request, status) {
  const url = new URL("/", request.url);
  url.searchParams.set("auth", status);
  return Response.redirect(url);
}

export async function GET(request, { params }) {
  const { provider } = await params;
  if (!providerConfigured(provider)) return redirectHome(request, provider + "_not_configured");
  const state = provider + ":" + randomBytes(18).toString("base64url");
  const url = authUrl(provider, request, state);
  if (!url) return redirectHome(request, "unsupported_provider");
  const response = Response.redirect(url);
  const configuredSite = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "";
  const isHttps = request.url.startsWith("https://") || configuredSite.startsWith("https://");
  const sameSite = provider === "apple" && isHttps ? "SameSite=None; Secure" : "SameSite=Lax";
  response.headers.append("Set-Cookie", `${oauthStateCookieName()}=${encodeURIComponent(state)}; Path=/; HttpOnly; ${sameSite}; Max-Age=600`);
  return response;
}
