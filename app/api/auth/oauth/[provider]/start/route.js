import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { authUrl, oauthStateCookieName, providerConfigured } from "../../_shared.js";

function redirectHome(request, status) {
  const url = new URL("/", request.url);
  url.searchParams.set("auth", status);
  return NextResponse.redirect(url);
}

export async function GET(request, { params }) {
  const { provider } = params;

  if (!providerConfigured(provider)) {
    return redirectHome(request, provider + "_not_configured");
  }

  const state = provider + ":" + randomBytes(18).toString("base64url");
  const url = authUrl(provider, request, state);

  if (!url) {
    return redirectHome(request, "unsupported_provider");
  }

  const configuredSite =
    process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "";
  const isHttps =
    request.url.startsWith("https://") || configuredSite.startsWith("https://");

  const sameSite = provider === "apple" && isHttps ? "none" : "lax";

  const response = NextResponse.redirect(url);

  response.cookies.set({
    name: oauthStateCookieName(),
    value: state,
    httpOnly: true,
    path: "/",
    sameSite,
    secure: sameSite === "none",
    maxAge: 600,
  });

  return response;
}
