import { randomBytes } from "node:crypto";
import { authUrl, oauthStateCookie, providerConfigured } from "../../_shared.js";

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
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": oauthStateCookie(request, state, 600),
    },
  });
}
