import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";
import { clean, ensureOAuthUser, signSession, setCookieValue } from "../../_utils.js";

const STATE_COOKIE = "lm_oauth_state";

export function oauthStateCookieName() { return STATE_COOKIE; }

export function siteOrigin(request) {
  const envUrl = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");
  return new URL(request.url).origin;
}

export function callbackUrl(request, provider) {
  return siteOrigin(request) + "/api/auth/oauth/" + provider + "/callback";
}

export function providerConfigured(provider) {
  if (provider === "google") return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (provider === "apple") {
    return Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
  }
  return false;
}

export function authUrl(provider, request, state) {
  if (provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID || "");
    url.searchParams.set("redirect_uri", callbackUrl(request, provider));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");
    return url;
  }
  if (provider === "apple") {
    const url = new URL("https://appleid.apple.com/auth/authorize");
    url.searchParams.set("client_id", process.env.APPLE_CLIENT_ID || "");
    url.searchParams.set("redirect_uri", callbackUrl(request, provider));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "form_post");
    url.searchParams.set("scope", "name email");
    url.searchParams.set("state", state);
    return url;
  }
  return null;
}

async function appleClientSecret() {
  const privateKey = String(process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const key = await importPKCS8(privateKey, "ES256");
  return new SignJWT({
    iss: process.env.APPLE_TEAM_ID,
    aud: "https://appleid.apple.com",
    sub: process.env.APPLE_CLIENT_ID,
  })
    .setProtectedHeader({ alg: "ES256", kid: process.env.APPLE_KEY_ID })
    .setIssuedAt()
    .setExpirationTime("180d")
    .sign(key);
}

async function exchangeCode(provider, request, code) {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", callbackUrl(request, provider));
  let url = "";
  if (provider === "google") {
    url = "https://oauth2.googleapis.com/token";
    body.set("client_id", process.env.GOOGLE_CLIENT_ID || "");
    body.set("client_secret", process.env.GOOGLE_CLIENT_SECRET || "");
  } else if (provider === "apple") {
    url = "https://appleid.apple.com/auth/token";
    body.set("client_id", process.env.APPLE_CLIENT_ID || "");
    body.set("client_secret", await appleClientSecret());
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    const err = new Error(data.error || "token_exchange_failed");
    err.code = data.error || "token_exchange_failed";
    throw err;
  }
  return data;
}

async function verifyIdToken(provider, idToken) {
  if (provider === "google") {
    const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    return payload;
  }
  if (provider === "apple") {
    const jwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: "https://appleid.apple.com",
      audience: process.env.APPLE_CLIENT_ID,
    });
    return payload;
  }
  const err = new Error("unsupported_provider");
  err.code = "unsupported_provider";
  throw err;
}

export async function finishOAuth(provider, request, code) {
  const token = await exchangeCode(provider, request, code);
  const payload = await verifyIdToken(provider, token.id_token);
  const email = String(payload.email || "").trim().toLowerCase();
  if (!email || payload.email_verified === false || payload.email_verified === "false") {
    const err = new Error("email_not_verified");
    err.code = "email_not_verified";
    throw err;
  }
  const result = await ensureOAuthUser({
    email,
    provider,
    providerId: clean(payload.sub, 180),
    username: clean(payload.name, 40) || email.split("@")[0],
  });
  if (!result.ok) {
    const err = new Error(result.error || "oauth_user_failed");
    err.code = result.error || "oauth_user_failed";
    throw err;
  }
  const session = signSession({ email, exp: Date.now() + 14 * 24 * 60 * 60 * 1000 });
  return { user: result.user, cookie: setCookieValue("lm_user", session), isNew: result.isNew };
}
