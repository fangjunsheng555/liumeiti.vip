import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  SMOKE_SECTIONS,
  UNAUTHENTICATED_API_CHECKS,
  probeSmokeHttp,
} from "../scripts/audit/smoke.mjs";

async function withServer(handler, callback) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, "close");
  }
}

function codes(findings) {
  return findings.map((item) => item.code);
}

test("smoke checklist has exactly 16 release sections and concrete safe GET paths", () => {
  assert.equal(SMOKE_SECTIONS.length, 16);
  const paths = SMOKE_SECTIONS.flatMap((section) => section.pages.map((page) => page.http));
  assert.ok(paths.includes("/services/spotify"));
  assert.ok(paths.includes("/checkout/quote/smoke-nonexistent-order"));
  assert.ok(paths.includes("/order-update/spotify/smoke-nonexistent-order"));
  assert.ok(paths.includes("/email/preferences?token=smoke-invalid-token"));
  assert.ok(paths.includes("/email/unsubscribe?token=smoke-invalid-token"));
  assert.ok(paths.every((value) => !/[\[\]<>]/.test(value)));
  assert.deepEqual(UNAUTHENTICATED_API_CHECKS.map((item) => [item.path, item.expectedStatus]), [
    ["/api/auth/me", 401],
    ["/api/admin/netflix-code", 401],
  ]);
});

test("adversarial 5xx page fixture is rejected", async () => {
  await withServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/html" });
    response.end("temporarily unavailable");
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "page", path: "/shop" }],
      timeoutMs: 500,
    });
    assert.deepEqual(codes(findings), ["smoke-http-5xx"]);
  });
});

test("adversarial disconnected network fixture is rejected", async () => {
  const server = createServer((_request, response) => response.end("unused"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  const findings = await probeSmokeHttp({
    baseUrl: `http://127.0.0.1:${port}`,
    targets: [{ kind: "page", path: "/" }],
    timeoutMs: 300,
  });
  assert.deepEqual(codes(findings), ["smoke-http-network"]);
});

test("adversarial hanging response body fixture is bounded by a timeout", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.flushHeaders();
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "page", path: "/account" }],
      timeoutMs: 30,
    });
    assert.deepEqual(codes(findings), ["smoke-http-timeout"]);
  });
});

test("adversarial invalid JSON fixture cannot masquerade as the expected 401 contract", async () => {
  await withServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end("{not-json");
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "json-api", path: "/api/auth/me", expectedStatus: 401 }],
      timeoutMs: 500,
    });
    assert.deepEqual(codes(findings), ["smoke-invalid-json"]);
  });
});

test("an HTML content type cannot masquerade as a healthy JSON API", async () => {
  await withServer((_request, response) => {
    response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    response.end(JSON.stringify({ error: "unauthorized" }));
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "json-api", path: "/api/auth/me", expectedStatus: 401 }],
      timeoutMs: 500,
    });
    assert.deepEqual(codes(findings), ["smoke-api-content-type"]);
  });
});

test("adversarial dynamic slug and token placeholders are rejected before any request", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    throw new Error("must not fetch unresolved placeholders");
  };
  const findings = await probeSmokeHttp({
    baseUrl: "https://example.test",
    fetchImpl,
    targets: [
      { kind: "page", path: "/services/[slug]" },
      { kind: "page", path: "/email/preferences?token=[token]" },
      { kind: "page", path: "/order-update/spotify/%5BorderId%5D" },
    ],
  });
  assert.equal(requests, 0);
  assert.deepEqual(codes(findings), [
    "smoke-dynamic-placeholder",
    "smoke-dynamic-placeholder",
    "smoke-dynamic-placeholder",
  ]);
});

test("healthy HTML and unauthenticated JSON fixtures produce no output", async () => {
  await withServer((request, response) => {
    if (request.url.startsWith("/api/")) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>ok</title>");
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [
        { kind: "page", path: "/" },
        { kind: "json-api", path: "/api/auth/me", expectedStatus: 401 },
      ],
      timeoutMs: 500,
    });
    assert.deepEqual(findings, []);
  });
});

test("a safe fake order may return an HTML 404 only when the route identity is still rendered", async () => {
  await withServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><main class="proxy-payment-page">Order not found</main>');
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "page", path: "/checkout/quote/smoke-nonexistent-order", allowNotFound: true, bodyMarkers: ["proxy-payment-page"] }],
      timeoutMs: 500,
    });
    assert.deepEqual(findings, []);
  });
});

test("convergence HTTP probe rejects a service route redirected to the homepage", async () => {
  await withServer((request, response) => {
    if (request.url === "/services/spotify") {
      response.writeHead(302, { location: "/" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Home</title>");
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "page", path: "/services/spotify", bodyMarkers: ["service-landing-shell"] }],
      timeoutMs: 500,
    });
    assert.deepEqual(codes(findings), ["smoke-unexpected-redirect"]);
  });
});

test("convergence HTTP probe rejects a 200 soft 404 page", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><title>404: This page could not be found.</title>');
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "page", path: "/shop" }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-soft-404"]);
  });
});

test("convergence HTTP probe rejects a generic quote-order 404 without route identity", async () => {
  await withServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<!doctype html><main>Order not found</main>");
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "page", path: "/checkout/quote/smoke-nonexistent-order", allowNotFound: true, bodyMarkers: ["proxy-payment-page"] }],
      timeoutMs: 500,
    });
    assert.deepEqual(codes(findings), ["smoke-page-marker-missing"]);
  });
});

test("convergence HTTP probe rejects a generic Spotify-update 404 without route identity", async () => {
  await withServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<!doctype html><main>Order not found</main>");
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "page", path: "/order-update/spotify/smoke-nonexistent-order", allowNotFound: true, bodyMarkers: ["spotify-update-page"] }],
      timeoutMs: 500,
    });
    assert.deepEqual(codes(findings), ["smoke-page-marker-missing"]);
  });
});

test("convergence HTTP probe rejects a homepage fallback served at a service URL", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><main class="home-page">Home</main>');
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "page", path: "/services/spotify", bodyMarkers: ["service-landing-shell"] }],
      timeoutMs: 500,
    });
    assert.deepEqual(codes(findings), ["smoke-page-marker-missing"]);
  });
});

test("official convergence round 1: a stalled unauthenticated API body times out", async () => {
  await withServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.write('{"error":"unauthorized"');
    response.flushHeaders();
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "json-api", path: "/api/auth/me", expectedStatus: 401 }],
      timeoutMs: 80,
    });
    assert.deepEqual(codes(findings), ["smoke-http-timeout"]);
  });
});

test("official convergence round 1: an API 503 cannot satisfy the expected 401", async () => {
  await withServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "backend_unavailable" }));
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "json-api", path: "/api/auth/me", expectedStatus: 401 }],
      timeoutMs: 500,
    });
    assert.deepEqual(codes(findings), ["smoke-http-5xx"]);
  });
});

test("official convergence round 1: an empty API error string fails the response contract", async () => {
  await withServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "" }));
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "json-api", path: "/api/auth/me", expectedStatus: 401 }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-api-contract"]);
  });
});

test("official convergence round 1: an array API body fails the response contract", async () => {
  await withServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify([{ error: "unauthorized" }]));
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "json-api", path: "/api/auth/me", expectedStatus: 401 }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-api-contract"]);
  });
});

test("official convergence round 1: a non-string API error fails the response contract", async () => {
  await withServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: 401 }));
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "json-api", path: "/api/auth/me", expectedStatus: 401 }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-api-contract"]);
  });
});

test("official convergence round 2: a page with JSON content type is rejected", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ html: "not-a-page" }));
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "page", path: "/shop" }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-page-content-type"]);
  });
});

test("official convergence round 2: an empty 204 page is rejected", async () => {
  await withServer((_request, response) => {
    response.writeHead(204, { "content-type": "text/html" });
    response.end();
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "page", path: "/legal" }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-page-empty"]);
  });
});

test("official convergence round 2: a regular page 404 is rejected", async () => {
  await withServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<!doctype html><main>missing</main>");
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "page", path: "/shop" }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-page-status"]);
  });
});

test("official convergence round 2: a rate-limited page is rejected", async () => {
  await withServer((_request, response) => {
    response.writeHead(429, { "content-type": "text/html", "retry-after": "60" });
    response.end("<!doctype html><main>slow down</main>");
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "page", path: "/account" }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-page-status"]);
  });
});

test("official convergence round 2: a valid 403 JSON body cannot replace the expected 401", async () => {
  await withServer((_request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "origin_forbidden" }));
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "json-api", path: "/api/auth/me", expectedStatus: 401 }],
      timeoutMs: 500,
    });
    assert.deepEqual(codes(findings), ["smoke-api-status"]);
  });
});

test("official convergence round 3: a Next not-found meta tag is rejected as a soft 404", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><meta name="next-error" content="not-found"><main>missing</main>');
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "page", path: "/guides" }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-soft-404"]);
  });
});

test("official convergence round 3: a Next fallback token is rejected as a soft 404", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><script>NEXT_HTTP_ERROR_FALLBACK;404</script>");
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "page", path: "/announcements" }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-soft-404"]);
  });
});

test("official convergence round 3: a whitespace-only HTML page is rejected as empty", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("  \r\n\t  ");
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "page", path: "/legal" }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-page-empty"]);
  });
});

test("official convergence round 3: an API object without error fails the unauthenticated contract", async () => {
  await withServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({ baseUrl, targets: [{ kind: "json-api", path: "/api/auth/me", expectedStatus: 401 }], timeoutMs: 500 });
    assert.deepEqual(codes(findings), ["smoke-api-contract"]);
  });
});

test("official convergence round 3: all declared route markers are required", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><main class="service-landing-shell">Spotify</main>');
  }, async (baseUrl) => {
    const findings = await probeSmokeHttp({
      baseUrl,
      targets: [{ kind: "page", path: "/services/spotify", bodyMarkers: ["service-landing-shell", "service-order-entry"] }],
      timeoutMs: 500,
    });
    assert.deepEqual(codes(findings), ["smoke-page-marker-missing"]);
    assert.match(findings[0].message, /service-order-entry/);
  });
});
