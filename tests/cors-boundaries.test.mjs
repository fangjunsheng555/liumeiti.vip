import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { NextRequest } from "../node_modules/next/server.js";

async function loadProxy() {
  let source = await fs.readFile(new URL("../proxy.js", import.meta.url), "utf8");
  const nextServerUrl = pathToFileURL(process.cwd() + "/node_modules/next/server.js").href;
  source = source.replace('from "next/server"', `from ${JSON.stringify(nextServerUrl)}`);
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}

function request(pathname, { method = "GET", origin = "", targetOrigin = "https://www.liumeiti.vip", headers = {} } = {}) {
  return new NextRequest(`${targetOrigin}${pathname}`, {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...headers,
    },
  });
}

test("credentialed CORS is restricted to exact tool origins and tool paths", async () => {
  const { proxy } = await loadProxy();

  const toolPreflight = await proxy(request("/api/tool/data", {
    method: "OPTIONS",
    origin: "https://tool.liumeiti.vip",
    headers: { "access-control-request-method": "PUT" },
  }));
  assert.equal(toolPreflight.status, 204);
  assert.equal(toolPreflight.headers.get("access-control-allow-origin"), "https://tool.liumeiti.vip");
  assert.equal(toolPreflight.headers.get("access-control-allow-credentials"), "true");

  const toolActual = await proxy(request("/api/tool/data?bucket=favs", {
    origin: "https://tool.liumeiti.vip",
  }));
  assert.equal(toolActual.headers.get("access-control-allow-origin"), "https://tool.liumeiti.vip");
  assert.equal(toolActual.headers.get("access-control-allow-credentials"), "true");

  for (const origin of [
    "https://evil.example",
    "https://tool.liumeiti.vip.evil.example",
    "null",
  ]) {
    const rejected = await proxy(request("/api/tool/data", {
      method: "OPTIONS",
      origin,
      headers: { "access-control-request-method": "GET" },
    }));
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  }
});

test("all cookie-authenticated account routes are covered by the proxy matcher", async () => {
  const { config } = await loadProxy();
  assert.ok(config.matcher.includes("/api/account/:path*"));
  assert.ok(config.matcher.includes("/api/order-query"));
});

test("the tool origin never reaches account mutations, money, orders or admin APIs", async () => {
  const { proxy } = await loadProxy();

  const accountPreflight = await proxy(request("/api/auth/me", {
    method: "OPTIONS",
    origin: "https://tool.liumeiti.vip",
    headers: { "access-control-request-method": "GET" },
  }));
  assert.equal(accountPreflight.status, 204);
  assert.equal(accountPreflight.headers.get("access-control-allow-origin"), "https://tool.liumeiti.vip");
  assert.equal(accountPreflight.headers.get("access-control-allow-methods"), "GET,HEAD,OPTIONS");

  const accountIdentity = await proxy(request("/api/auth/me", {
    origin: "https://tool.liumeiti.vip",
  }));
  assert.equal(accountIdentity.status, 200);
  assert.equal(accountIdentity.headers.get("access-control-allow-origin"), "https://tool.liumeiti.vip");
  assert.equal(accountIdentity.headers.get("access-control-allow-credentials"), "true");

  for (const [pathname, method] of [
    ["/api/admin/users/list", "GET"],
    ["/api/admin/users/test%40example.com", "PATCH"],
    ["/api/auth/me", "PATCH"],
    // Sign-in is part of the tool origin's SSO surface, but only through its
    // real methods: anything else on the same path stays same-origin-only.
    ["/api/auth/login", "PUT"],
    ["/api/auth/captcha", "POST"],
    ["/api/auth/balance", "GET"],
    ["/api/auth/transfer", "POST"],
    ["/api/auth/withdraw", "POST"],
    ["/api/auth/redeem", "POST"],
    ["/api/account/email-preferences", "PATCH"],
    ["/api/order", "POST"],
    ["/api/order-query", "POST"],
    ["/api/quote-orders/LM123", "POST"],
    ["/api/netflix-code", "POST"],
    ["/api/test-email", "POST"],
  ]) {
    const rejected = await proxy(request(pathname, {
      method,
      origin: "https://tool.liumeiti.vip",
    }));
    assert.equal(rejected.status, 403, `${method} ${pathname}`);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  }

  const adminPreflight = await proxy(request("/api/admin/users/list", {
    method: "OPTIONS",
    origin: "https://tool.liumeiti.vip",
    headers: { "access-control-request-method": "GET" },
  }));
  assert.equal(adminPreflight.status, 403);
  assert.equal(adminPreflight.headers.get("access-control-allow-origin"), null);

  const sameOriginAdmin = await proxy(request("/api/admin/users/test%40example.com", {
    method: "PATCH",
    origin: "https://www.liumeiti.vip",
  }));
  assert.equal(sameOriginAdmin.status, 200);
  assert.equal(sameOriginAdmin.headers.get("x-middleware-next"), "1");

  // OAuth callbacks are top-level cross-site GET navigations and commonly do
  // not contain Origin. They must remain reachable after origin hardening.
  const oauthCallback = await proxy(request("/api/auth/oauth/google/callback?code=test", {
    headers: { "sec-fetch-site": "cross-site" },
  }));
  assert.equal(oauthCallback.status, 200);
  assert.equal(oauthCallback.headers.get("x-middleware-next"), "1");

  const sameOriginPreferences = await proxy(request("/api/account/email-preferences", {
    method: "PATCH",
    origin: "https://www.liumeiti.vip",
  }));
  assert.equal(sameOriginPreferences.status, 200);
  assert.equal(sameOriginPreferences.headers.get("x-middleware-next"), "1");

  const sameOriginOrderQuery = await proxy(request("/api/order-query", {
    method: "POST",
    origin: "https://www.liumeiti.vip",
  }));
  assert.equal(sameOriginOrderQuery.status, 200);
  assert.equal(sameOriginOrderQuery.headers.get("x-middleware-next"), "1");
});

test("apex and www storefront origins trust each other without trusting lookalikes", async () => {
  const { proxy } = await loadProxy();

  for (const [targetOrigin, origin] of [
    ["https://www.liumeiti.vip", "https://liumeiti.vip"],
    ["https://liumeiti.vip", "https://www.liumeiti.vip"],
  ]) {
    const preflight = await proxy(request("/api/order", {
      targetOrigin,
      origin,
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,idempotency-key",
      },
    }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("access-control-allow-methods") || "", /POST/);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");

    const actual = await proxy(request("/api/order", {
      targetOrigin,
      origin,
      method: "POST",
    }));
    assert.equal(actual.status, 200);
    assert.equal(actual.headers.get("access-control-allow-origin"), origin);

    const preferenceWrite = await proxy(request("/api/account/email-preferences", {
      targetOrigin,
      origin,
      method: "PATCH",
    }));
    assert.equal(preferenceWrite.status, 200);
    assert.equal(preferenceWrite.headers.get("access-control-allow-origin"), origin);
  }

  for (const origin of ["https://liumeiti.vip.evil.example", "https://www-liumeiti.vip"]) {
    const rejected = await proxy(request("/api/order", { method: "POST", origin }));
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  }
});

test("the tool origin can sign in, out and recover through the shared account system", async () => {
  const { proxy } = await loadProxy();
  const origin = "https://tool.liumeiti.vip";

  // The tool site has no account system of its own: its client signs in
  // against the main site's session cookie. Blocking these turned every tool
  // site sign-in into a generic network error.
  for (const [pathname, method] of [
    ["/api/auth/login", "POST"],
    ["/api/auth/login", "DELETE"],
    ["/api/auth/captcha", "GET"],
    ["/api/auth/register", "POST"],
    ["/api/auth/forgot", "POST"],
    ["/api/auth/reset", "POST"],
  ]) {
    const preflight = await proxy(request(pathname, {
      method: "OPTIONS",
      origin,
      headers: { "access-control-request-method": method },
    }));
    assert.equal(preflight.status, 204, `preflight ${method} ${pathname}`);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
    assert.ok(
      preflight.headers.get("access-control-allow-methods").split(",").includes(method),
      `${pathname} preflight must offer ${method}, got ${preflight.headers.get("access-control-allow-methods")}`,
    );

    const actual = await proxy(request(pathname, { method, origin }));
    assert.equal(actual.status, 200, `${method} ${pathname}`);
    assert.equal(actual.headers.get("x-middleware-next"), "1");
    assert.equal(actual.headers.get("access-control-allow-origin"), origin);
    assert.equal(actual.headers.get("access-control-allow-credentials"), "true");
  }

  // The sign-in path advertises exactly its own methods, not the tool API's
  // broad list: a PUT preflight on it must not be offered PUT.
  const loginPreflight = await proxy(request("/api/auth/login", {
    method: "OPTIONS",
    origin,
    headers: { "access-control-request-method": "PUT" },
  }));
  assert.equal(loginPreflight.headers.get("access-control-allow-methods"), "POST,DELETE,OPTIONS");

  // The same endpoints stay closed to any origin outside the allowlist.
  for (const badOrigin of ["https://tool.liumeiti.vip.evil.example", "https://evil.example"]) {
    const rejected = await proxy(request("/api/auth/login", { method: "POST", origin: badOrigin }));
    assert.equal(rejected.status, 403, badOrigin);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  }
});
