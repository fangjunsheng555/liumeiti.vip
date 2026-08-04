import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { fetchNetflixJson } from "../app/netflix-code/fetch-json.js";

async function withHttpServer(handler, callback) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
    if (server.listening) await once(server, "close");
  }
}

test("Netflix account loading bounds a JSON body that stalls after response headers", async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":true,"orders":[');
    response.flushHeaders();
  }, async (baseUrl) => {
    const startedAt = Date.now();
    await assert.rejects(
      fetchNetflixJson(`${baseUrl}/api/auth/me`, { cache: "no-store" }, 35),
      (error) => error?.name === "AbortError",
    );
    assert.ok(Date.now() - startedAt < 500, "the response body deadline must end loading promptly");
  });
});

test("Netflix account loading preserves a complete 503 JSON response for readable UI handling", async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "session_store_unavailable" }));
  }, async (baseUrl) => {
    const { response, data } = await fetchNetflixJson(`${baseUrl}/api/auth/me`, {}, 200);
    assert.equal(response.status, 503);
    assert.deepEqual(data, { ok: false, error: "session_store_unavailable" });
  });
});

test("Netflix account loading rejects malformed JSON instead of retaining loading state", async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{not-json");
  }, async (baseUrl) => {
    await assert.rejects(fetchNetflixJson(`${baseUrl}/api/auth/me`, {}, 200), SyntaxError);
  });
});

test("Netflix account loading surfaces a disconnected response as a rejected request", async () => {
  await withHttpServer((request) => {
    request.socket.destroy();
  }, async (baseUrl) => {
    await assert.rejects(fetchNetflixJson(`${baseUrl}/api/auth/me`, {}, 200));
  });
});

test("Netflix account loading consumes a delayed chunked 401 body inside the deadline", async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.write('{"ok":false,');
    globalThis.setTimeout(() => response.end('"error":"unauthorized"}'), 20);
  }, async (baseUrl) => {
    const { response, data } = await fetchNetflixJson(`${baseUrl}/api/auth/me`, {}, 250);
    assert.equal(response.status, 401);
    assert.equal(data.error, "unauthorized");
  });
});

test("official convergence round 1: caller cancellation aborts a stalled JSON body", async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":true');
    response.flushHeaders();
  }, async (baseUrl) => {
    const controller = new AbortController();
    const cancel = globalThis.setTimeout(() => controller.abort(), 20);
    try {
      await assert.rejects(
        fetchNetflixJson(`${baseUrl}/api/auth/me`, { signal: controller.signal }, 500),
        (error) => error?.name === "AbortError",
      );
    } finally {
      globalThis.clearTimeout(cancel);
    }
  });
});

test("official convergence round 1: one timed-out request cannot abort a concurrent success", async () => {
  await withHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/slow") {
      response.write('{"ok":true');
      response.flushHeaders();
      return;
    }
    response.end(JSON.stringify({ ok: true, orders: [] }));
  }, async (baseUrl) => {
    const slowRejected = assert.rejects(
      fetchNetflixJson(`${baseUrl}/slow`, {}, 30),
      (error) => error?.name === "AbortError",
    );
    const fast = fetchNetflixJson(`${baseUrl}/fast`, {}, 300);
    const { response, data } = await fast;
    assert.equal(response.status, 200);
    assert.deepEqual(data, { ok: true, orders: [] });
    await slowRejected;
  });
});

test("official convergence round 1: a three-chunk JSON response completes before its deadline", async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":');
    globalThis.setTimeout(() => response.write('true,"orders":'), 10);
    globalThis.setTimeout(() => response.end("[]}"), 20);
  }, async (baseUrl) => {
    const { data } = await fetchNetflixJson(`${baseUrl}/api/auth/me`, {}, 250);
    assert.deepEqual(data, { ok: true, orders: [] });
  });
});

test("official convergence round 1: a pre-aborted signal sends no HTTP request", async () => {
  let requests = 0;
  await withHttpServer((_request, response) => {
    requests += 1;
    response.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fetchNetflixJson(`${baseUrl}/api/auth/me`, { signal: controller.signal }, 250),
      (error) => error?.name === "AbortError",
    );
    assert.equal(requests, 0);
  });
});

test("official convergence round 1: a valid JSON null body is consumed without hanging", async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("null");
  }, async (baseUrl) => {
    const { response, data } = await fetchNetflixJson(`${baseUrl}/api/auth/me`, {}, 250);
    assert.equal(response.status, 200);
    assert.equal(data, null);
  });
});
