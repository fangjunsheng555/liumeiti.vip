import { finishOAuth, oauthStateCookieName, oauthStateCookie, oauthReturnCookieName, oauthReturnCookie, safeReturnTo } from "../../_shared.js";

function redirectHome(request, status, cookie = "") {
  const url = new URL("/", request.url);
  url.searchParams.set("auth", status);
  const response = new Response(null, {
    status: 302,
    headers: { Location: url.toString() },
  });
  if (cookie) response.headers.append("Set-Cookie", cookie);
  return response;
}

function readCookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : "";
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
    const returnTo = safeReturnTo(readCookie(request, oauthReturnCookieName()));
    let response;
    if (returnTo) {
      // 回到发起登录的子站原页(如工具站)。会话 cookie 由本回调(www)落库,子站同站请求带得上。
      response = new Response(null, { status: 302, headers: { Location: returnTo } });
      response.headers.append("Set-Cookie", result.cookie);
    } else {
      response = redirectHome(request, result.isNew ? "oauth_new" : "oauth_ok", result.cookie);
    }
    response.headers.append("Set-Cookie", oauthStateCookie(request, "", 0));
    response.headers.append("Set-Cookie", oauthReturnCookie(request, "", 0));
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
