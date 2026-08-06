import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";

const runRealRedis = process.env.RUN_REAL_REDIS_TESTS === "1";
const redisToken = process.env.KV_REST_API_TOKEN || "local-test-token";
process.env.AUTH_SECRET ||= "spotify-real-test-secret-at-least-32-characters";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

let redisUrl = "";

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRedisRestFixture() {
  const suffix = `${process.pid}-${Date.now()}`;
  const container = `lm-spotify-route-${suffix}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Redis container did not become ready");
    const port = await availablePort();
    const proxy = spawn(process.execPath, [fileURLToPath(new URL("./helpers/upstash-rest-server.mjs", import.meta.url))], {
      env: {
        ...process.env,
        TEST_REDIS_CONTAINER: container,
        TEST_REDIS_HTTP_PORT: String(port),
        TEST_REDIS_TOKEN: redisToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proxy.stderr.setEncoding("utf8");
    proxy.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Redis REST proxy start timeout: ${stderr}`)), 10_000);
      proxy.once("error", reject);
      proxy.stdout.setEncoding("utf8");
      proxy.stdout.on("data", (chunk) => {
        if (String(chunk).includes("local_upstash_rest=")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    return {
      container,
      proxy,
      url: `http://127.0.0.1:${port}`,
      close() {
        proxy.kill();
        docker(["rm", "-f", container]);
      },
    };
  } catch (error) {
    docker(["rm", "-f", container]);
    throw error;
  }
}

async function redis(...command) {
  const response = await fetch(`${redisUrl}/${command.map((part) => encodeURIComponent(String(part))).join("/")}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  });
  assert.equal(response.ok, true, `Redis REST command failed: ${command[0]}`);
  return (await response.json()).result;
}

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

test("Spotify correction is recoverable and a used-link 410 creates no Redis operation", {
  skip: runRealRedis ? false : "set RUN_REAL_REDIS_TESTS=1 for Docker-backed Lua verification",
}, async () => {
  const fixture = await startRedisRestFixture();
  redisUrl = fixture.url;
  process.env.KV_REST_API_URL = redisUrl;
  process.env.KV_REST_API_TOKEN = redisToken;
  const suffix = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`.toUpperCase();
  const orderId = `LMREALSPOTIFY${suffix}`;
  const token = `spotify-real-token-${suffix}`;
  const idempotencyKey = `spotify-real-update-${suffix}`;
  const rejectedKey = `spotify-real-rejected-${suffix}`;
  const tokenHash = sha(token);
  const principal = `${orderId}:${tokenHash}`;
  const operationId = sha(`spotify-password-update\0${principal}\0${idempotencyKey}`);
  const rejectedOperationId = sha(`spotify-password-update\0${principal}\0${rejectedKey}`);
  const recordKey = `liumeiti:orders:record:${orderId}`;
  const startedIndex = "liumeiti:durable-operation:v1:started-index";
  const order = {
    orderId,
    revision: 0,
    status: "received",
    createdAt: new Date().toISOString(),
    email: "before-real-test@example.com",
    contact: "before-contact",
    remark: "before-note",
    account: "before@example.com",
    password: "before-password",
    staffAccount: "stale-staff@example.com",
    staffPassword: "stale-staff-password",
    items: [{
      service: "spotify",
      label: "Spotify",
      account: "before@example.com",
      password: "before-password",
      staffAccount: "stale-staff@example.com",
      staffPassword: "stale-staff-password",
      passwordCorrectionTokenHash: tokenHash,
      passwordCorrectionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, {
      service: "netflix",
      label: "Netflix",
      account: "untouched@example.com",
      password: "untouched-password",
    }],
  };

  await redis("SET", recordKey, JSON.stringify(order));
  const route = await import("../app/api/order-password-update/[orderId]/route.js");
  const payload = {
    account: "persisted-real@example.com",
    password: "persisted-real-password",
    email: "buyer-real@example.com",
    contact: "real-contact",
    remark: "real-note",
  };
  const request = (key) => new Request(`https://www.liumeiti.vip/api/order-password-update/${orderId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "User-Agent": `spotify-real-test-${suffix}`,
      "X-Forwarded-For": `198.51.100.${(Number.parseInt(suffix.slice(-2), 16) % 200) + 1}`,
    },
    body: JSON.stringify(payload),
  });

  try {
    const response = await route.PATCH(request(idempotencyKey), {
      params: Promise.resolve({ orderId }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);

    const persisted = JSON.parse(await redis("GET", recordKey));
    assert.equal(persisted.items[0].account, payload.account);
    assert.equal(persisted.items[0].password, payload.password);
    assert.equal(persisted.account, payload.account);
    assert.equal(persisted.password, payload.password);
    assert.equal(persisted.staffAccount, "");
    assert.equal(persisted.staffPassword, "");
    assert.equal(persisted.items[1].account, "untouched@example.com");
    assert.equal(persisted.items[1].password, "untouched-password");
    assert.equal(persisted.items[0].passwordCorrectionResolvedOperationId, operationId);

    const operation = JSON.parse(await redis("GET", `liumeiti:durable-operation:v1:${operationId}`));
    assert.equal(operation.state, "done");
    assert.equal(await redis("ZSCORE", startedIndex, operationId), null);

    const replay = await route.PATCH(request(idempotencyKey), {
      params: Promise.resolve({ orderId }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent, true);

    const rejected = await route.PATCH(request(rejectedKey), {
      params: Promise.resolve({ orderId }),
    });
    assert.equal(rejected.status, 410);
    assert.equal((await rejected.json()).error, "update_link_used");
    assert.equal(await redis("GET", `liumeiti:durable-operation:v1:${rejectedOperationId}`), null);
    assert.equal(await redis("ZSCORE", startedIndex, rejectedOperationId), null);
  } finally {
    const timelineMarker = sha(`${orderId}\0${operationId}:timeline`);
    const adminMarker = sha(`${operationId}:admin-log`);
    await redis(
      "DEL",
      recordKey,
      `liumeiti:durable-operation:v1:${operationId}`,
      `liumeiti:durable-operation:v1:${rejectedOperationId}`,
      `liumeiti:order-timeline:${orderId}`,
      `liumeiti:order-timeline-once:v1:${timelineMarker}`,
      `liumeiti:admin-action-once:v1:${adminMarker}`,
      `lm:order:update-lock:${orderId}`,
    );
    await redis("ZREM", startedIndex, operationId, rejectedOperationId);
    await redis("LREM", "liumeiti:orders:index", "0", orderId);
    await redis("SREM", "liumeiti:orders:index:members", orderId);
    await redis("HDEL", "liumeiti:orders:overview", orderId);
    await redis("ZREM", "liumeiti:orders:summary-created", orderId);
    await redis("LREM", "liumeiti:orders:email:before-real-test@example.com", "0", orderId);
    await redis("LREM", "liumeiti:orders:email:buyer-real@example.com", "0", orderId);
    fixture.close();
  }
});
