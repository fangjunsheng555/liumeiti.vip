import { finishOAuth, oauthStateCookieName } from "../../_shared.js";

function redirectHome(request, status, cookie = "") {
  const url = new URL("/", request.url);
  url.searchParams.set("auth", status);
  const response = Response.redirect(url);
  if (cookie) response.headers.append("Set-Cookie", cookie);
  return response;
}

async function handleOAuthCallback(request, provider, values) {
  const code = values.get("code") || "";
  const state = values.get("state") || "";
  const error = values.get("error") || "";
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${oauthStateCookieName()}=([^;]+)`));
  const expectedState = match ? decodeURIComponent(match[1]) : "";

  if (error) return redirectHome(request, error);
  if (!code || !state || state !== expectedState || !state.startsWith(provider + ":")) {
    return redirectHome(request, "invalid_oauth_state");
  }

  try {
    const result = await finishOAuth(provider, request, code);
    const clearState = `${oauthStateCookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    const response = redirectHome(request, result.isNew ? "oauth_new" : "oauth_ok", result.cookie);
    response.headers.append("Set-Cookie", clearState);
    return response;
  } catch (e) {
    return redirectHome(request, e.code || "oauth_failed");
  }
}

export async function GET(request, { params }) {
  const { provider } = await params;
  const url = new URL(request.url);
  return handleOAuthCallback(request, provider, url.searchParams);
}

export async function POST(request, { params }) {
  const { provider } = await params;
  const form = await request.formData();
  return handleOAuthCallback(request, provider, form);
}
