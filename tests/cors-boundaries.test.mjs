import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { NextRequest } from "../node_modules/next/server.js";

async function loadMiddleware() {
  let source = await fs.readFile(new URL("../middleware.js", import.meta.url), "utf8");
  const nextServerUrl = pathToFileURL(process.cwd() + "/node_modules/next/server.js").href;
  source = source.replace('from "next/server"', `from ${JSON.stringify(nextServerUrl)}`);
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}

function request(pathname, { method = "GET", origin = "", headers = {} } = {}) {
  return new NextRequest(`https://www.liumeiti.vip${pathname}`, {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...headers,
    },
  });
}

test("credentialed CORS is restricted to exact tool origins and tool paths", async () => {
  const { middleware } = await loadMiddleware();

  const toolPreflight = await middleware(request("/api/tool/data", {
    method: "OPTIONS",
    origin: "https://tool.liumeiti.vip",
    headers: { "access-control-request-method": "PUT" },
  }));
  assert.equal(toolPreflight.status, 204);
  assert.equal(toolPreflight.headers.get("access-control-allow-origin"), "https://tool.liumeiti.vip");
  assert.equal(toolPreflight.headers.get("access-control-allow-credentials"), "true");

  const toolActual = await middleware(request("/api/tool/data?bucket=favs", {
    origin: "https://tool.liumeiti.vip",
  }));
  assert.equal(toolActual.headers.get("access-control-allow-origin"), "https://tool.liumeiti.vip");
  assert.equal(toolActual.headers.get("access-control-allow-credentials"), "true");

  for (const origin of [
    "https://evil.example",
    "https://tool.liumeiti.vip.evil.example",
    "null",
  ]) {
    const rejected = await middleware(request("/api/tool/data", {
      method: "OPTIONS",
      origin,
      headers: { "access-control-request-method": "GET" },
    }));
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  }
});

test("the tool origin cannot read or mutate admin and account APIs", async () => {
  const { middleware } = await loadMiddleware();

  for (const [pathname, method] of [
    ["/api/admin/users/list", "GET"],
    ["/api/admin/users/test%40example.com", "PATCH"],
    ["/api/auth/me", "GET"],
    ["/api/auth/transfer", "POST"],
    ["/api/order", "POST"],
    ["/api/quote-orders/LM123", "POST"],
    ["/api/netflix-code", "POST"],
    ["/api/test-email", "POST"],
  ]) {
    const rejected = await middleware(request(pathname, {
      method,
      origin: "https://tool.liumeiti.vip",
    }));
    assert.equal(rejected.status, 403, `${method} ${pathname}`);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  }

  const adminPreflight = await middleware(request("/api/admin/users/list", {
    method: "OPTIONS",
    origin: "https://tool.liumeiti.vip",
    headers: { "access-control-request-method": "GET" },
  }));
  assert.equal(adminPreflight.status, 403);
  assert.equal(adminPreflight.headers.get("access-control-allow-origin"), null);

  const sameOriginAdmin = await middleware(request("/api/admin/users/test%40example.com", {
    method: "PATCH",
    origin: "https://www.liumeiti.vip",
  }));
  assert.equal(sameOriginAdmin.status, 200);
  assert.equal(sameOriginAdmin.headers.get("x-middleware-next"), "1");

  // OAuth callbacks are top-level cross-site GET navigations and commonly do
  // not contain Origin. They must remain reachable after origin hardening.
  const oauthCallback = await middleware(request("/api/auth/oauth/google/callback?code=test", {
    headers: { "sec-fetch-site": "cross-site" },
  }));
  assert.equal(oauthCallback.status, 200);
  assert.equal(oauthCallback.headers.get("x-middleware-next"), "1");
});
