import { randomBytes } from "node:crypto";
import {
  authUrl, oauthInviteCodeFromStartRequest, oauthInviteCookie,
  oauthStateCookie, oauthReturnCookie, safeReturnTo, providerConfigured,
} from "../../_shared.js";

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
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  const inviteCode = oauthInviteCodeFromStartRequest(request);
  const headers = new Headers({ Location: url.toString() });
  headers.append("Set-Cookie", oauthStateCookie(request, state, 600));
  // 记下回跳地址(如工具站),登录完成后回到原站原页;无则走默认回首页。
  headers.append("Set-Cookie", oauthReturnCookie(request, returnTo, returnTo ? 600 : 0));
  headers.append("Set-Cookie", oauthInviteCookie(request, inviteCode, inviteCode ? 600 : 0));
  return new Response(null, { status: 302, headers });
}
