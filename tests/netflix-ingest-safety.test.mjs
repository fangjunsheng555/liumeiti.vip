import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { POST as ingestNetflixMail } from "../app/api/webhooks/netflix-email/route.js";
import { eligibility } from "../app/api/netflix-code/route.js";

function netflixMime() {
  return [
    "From: Netflix <info@account.netflix.com>",
    "To: member@example.com",
    "Subject: Your Netflix sign-in code",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Use this login code to sign in to Netflix: 4827. It expires in 15 minutes.",
    "",
  ].join("\r\n");
}

function signedRequest(raw, secret) {
  const timestamp = String(Date.now());
  const digest = createHash("sha256").update(raw).digest("hex");
  const signature = createHmac("sha256", secret).update(`${timestamp}\n${digest}`).digest("base64url");
  return new Request("https://codes.liumeiti.vip/api/webhooks/netflix-email", {
    method: "POST",
    headers: {
      "content-type": "message/rfc822",
      "x-email-timestamp": timestamp,
      "x-email-signature": `v1=${signature}`,
      "x-email-message-id": "netflix-ingest-safety-test",
      "x-email-envelope-from": "info@account.netflix.com",
      "x-email-envelope-to": "netflix@codes.liumeiti.vip",
    },
    body: raw,
  });
}

function installRedis({ loseFirstReplaySetResponse = false } = {}) {
  const strings = new Map();
  const sortedSets = new Map();
  let lost = false;

  const execute = (command) => {
    const [name, ...args] = command.map(String);
    if (name === "PING") return "PONG";
    if (name === "GET") return strings.get(args[0]) ?? null;
    if (name === "SET") {
      const [key, value] = args;
      if (args.includes("NX") && strings.has(key)) return null;
      strings.set(key, value);
      return "OK";
    }
    if (name === "DEL") return strings.delete(args[0]) ? 1 : 0;
    if (name === "INCR") {
      const next = Number(strings.get(args[0]) || 0) + 1;
      strings.set(args[0], String(next));
      return next;
    }
    if (name === "ZADD") {
      const set = sortedSets.get(args[0]) || new Map();
      set.set(args[2], Number(args[1]));
      sortedSets.set(args[0], set);
      return 1;
    }
    if (name === "ZREMRANGEBYSCORE") return 0;
    if (name === "EVAL") {
      const [script, , key, expected, next] = args;
      if ((strings.get(key) ?? null) !== expected) return 0;
      if (script.includes("redis.call('DEL'")) return strings.delete(key) ? 1 : 0;
      strings.set(key, next);
      return 1;
    }
    throw new Error(`unsupported Redis command: ${name}`);
  };

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/pipeline")) {
      const commands = JSON.parse(init.body || "[]");
      return Response.json(commands.map((command) => ({ result: execute(command) })));
    }
    const command = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (loseFirstReplaySetResponse && !lost && command[0] === "SET"
      && String(command[1]).includes("netflix-mail:ingest:")) {
      lost = true;
      execute(command);
      return new Response("", { status: 503 });
    }
    return Response.json({ result: execute(command) });
  };
  return { strings, wasResponseLost: () => lost };
}

test("ingest recovers when replay SET commits but its HTTP response is lost", async (t) => {
  const previous = {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
    ingestSecret: process.env.NETFLIX_EMAIL_INGEST_SECRET,
    encryption: process.env.NETFLIX_CODE_ENCRYPTION_KEY,
    fetch: globalThis.fetch,
  };
  process.env.KV_REST_API_URL = "https://redis.netflix-ingest.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  process.env.NETFLIX_EMAIL_INGEST_SECRET = "netflix-ingest-test-secret-at-least-32-characters";
  process.env.NETFLIX_CODE_ENCRYPTION_KEY = "netflix-ingest-encryption-key-at-least-32-chars";
  const redis = installRedis({ loseFirstReplaySetResponse: true });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (key === "fetch") continue;
      const envKey = key === "url" ? "KV_REST_API_URL"
        : key === "token" ? "KV_REST_API_TOKEN"
          : key === "ingestSecret" ? "NETFLIX_EMAIL_INGEST_SECRET"
            : "NETFLIX_CODE_ENCRYPTION_KEY";
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
    globalThis.fetch = previous.fetch;
  });

  const raw = netflixMime();
  const first = await ingestNetflixMail(signedRequest(raw, process.env.NETFLIX_EMAIL_INGEST_SECRET));
  const firstBody = await first.json();
  assert.equal(redis.wasResponseLost(), true);
  assert.equal(first.status, 202);
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.duplicate, undefined);
  assert.ok(redis.strings.has(`liumeiti:netflix-mail:event:${firstBody.eventId}`));

  const replay = await ingestNetflixMail(signedRequest(raw, process.env.NETFLIX_EMAIL_INGEST_SECRET));
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), { ok: true, duplicate: true });

  // A marker by itself is not proof of a committed ingest. If the durable
  // event disappears, the next retry rebuilds it instead of returning a false
  // duplicate acknowledgement.
  redis.strings.delete(`liumeiti:netflix-mail:event:${firstBody.eventId}`);
  const repaired = await ingestNetflixMail(signedRequest(raw, process.env.NETFLIX_EMAIL_INGEST_SECRET));
  const repairedBody = await repaired.json();
  assert.equal(repaired.status, 202);
  assert.equal(repairedBody.ok, true);
  assert.equal(repairedBody.duplicate, undefined);
  assert.ok(redis.strings.has(`liumeiti:netflix-mail:event:${firstBody.eventId}`));
});

test("user Netflix disable lookup fails closed on an auth-store outage", async (t) => {
  const previous = {
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
    fetch: globalThis.fetch,
  };
  process.env.KV_REST_API_URL = "https://redis.netflix-user-toggle.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  globalThis.fetch = async () => new Response("", { status: 503 });
  t.after(() => {
    if (previous.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = previous.url;
    if (previous.token === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = previous.token;
    globalThis.fetch = previous.fetch;
  });

  const result = await eligibility({
    orderId: "LM-NETFLIX-STORE-OUTAGE",
    status: "received",
    email: "delivery@example.com",
    userEmail: "owner@example.com",
    items: [{ service: "netflix", staffAccount: "member@example.com" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, "storage_unavailable");
});
