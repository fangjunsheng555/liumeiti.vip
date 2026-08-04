import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.KV_REST_API_URL = "http://netflix-search.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const {
  listAllNetflixCodeAccess,
  listAllNetflixMailEvents,
} = await import("../app/api/netflix-code/_store.js");

test("full Netflix search readers continue beyond the preview limits", async () => {
  const originalFetch = global.fetch;
  const mailIds = Array.from({ length: 101 }, (_, index) => `NM${index.toString(16).toUpperCase().padStart(24, "0")}`);
  const accessIds = Array.from({ length: 201 }, (_, index) => `NA${index.toString(16).toUpperCase().padStart(16, "0")}`);
  const records = new Map([
    ...mailIds.map((id) => [`liumeiti:netflix-mail:event:${id}`, {
      eventId: id,
      accepted: false,
      accountHashes: [],
      receivedAt: "2026-08-04T00:00:00.000Z",
      expiresAt: "2026-08-11T00:00:00.000Z",
      kind: "",
      payload: null,
    }]),
    ...accessIds.map((id, index) => [`liumeiti:netflix-code:access:${id}`, {
      id,
      orderId: `ORDER-${index}`,
      eventId: mailIds[index % mailIds.length],
      outcome: "code_returned",
      createdAt: "2026-08-04T00:00:00.000Z",
    }]),
  ]);

  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(String(init.body || "[]"));
      return Response.json(commands.map((command) => ({ result: JSON.stringify(records.get(command[1]) || null) })));
    }
    const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (command[0] !== "ZREVRANGE") return Response.json({ result: null });
    const ids = command[1] === "liumeiti:netflix-mail:received" ? mailIds : accessIds;
    const start = Number(command[2]);
    const stop = Number(command[3]);
    return Response.json({ result: ids.slice(start, stop + 1) });
  };

  try {
    const mail = await listAllNetflixMailEvents();
    const access = await listAllNetflixCodeAccess();
    assert.equal(mail.length, 101);
    assert.equal(access.length, 201);
    assert.equal(mail.at(-1).eventId, mailIds.at(-1));
    assert.equal(access.at(-1).id, accessIds.at(-1));
  } finally {
    global.fetch = originalFetch;
  }
});

test("admin Netflix search uses a revision cache and batched user reads", async () => {
  const route = await readFile(new URL("../app/api/admin/netflix-code/route.js", import.meta.url), "utf8");
  const getHandler = route.slice(0, route.indexOf("export async function PATCH"));
  const patchHandler = route.slice(route.indexOf("export async function PATCH"));
  const publicRoute = await readFile(new URL("../app/api/netflix-code/route.js", import.meta.url), "utf8");
  const panel = await readFile(new URL("../app/admin/NetflixCodePanel.jsx", import.meta.url), "utf8");
  assert.match(getHandler, /NETFLIX_ORDER_DIRECTORY_CACHE_KEY/);
  assert.match(getHandler, /redisPipeline\(batch\.map/);
  assert.match(getHandler, /netflixMailSearchValues\(searchOrders\)/);
  assert.match(getHandler, /\[\.\.\.exactOrders, \.\.\.matchedOrders\]/);
  assert.doesNotMatch(getHandler, /\bgetUser\s*\(/);
  assert.match(getHandler, /netflixOrderIdentity\(order\)\.ownerEmail/);
  assert.match(patchHandler, /const \{ ownerEmail \} = netflixOrderIdentity\(entry\.order\)/);
  assert.match(publicRoute, /const \{ ownerEmail \} = netflixOrderIdentity\(order\)/);
  assert.match(publicRoute, /isNetflixOrderOwner\(order, userSession\.email\)/);
  assert.doesNotMatch(publicRoute, /\[orderEmail, normalizeEmail\(order\?\.userEmail\)\]/);
  assert.match(panel, /收件邮箱：/);
  assert.match(panel, /购买账号：/);
  assert.match(panel, /new AbortController\(\)/);
  assert.match(panel, /params\.set\("scope", scope\)/);
});
