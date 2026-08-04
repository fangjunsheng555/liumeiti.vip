import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import { getOrCreateResetCode } from "../app/api/_utils.js";
import { POST as forgotPassword } from "../app/api/auth/forgot/route.js";

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

const execFileAsync = promisify(execFile);

async function dockerAsync(args) {
  const result = await execFileAsync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}

function realRedis(container) {
  const run = (command) => {
    const child = docker(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis-cli failed");
    const output = child.stdout.trim();
    return output ? JSON.parse(output) : null;
  };
  const runAsync = async (command) => {
    const stdout = await dockerAsync(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    const output = stdout.trim();
    return output ? JSON.parse(output) : null;
  };
  return {
    run,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/pipeline") {
        const commands = JSON.parse(String(init.body || "[]"));
        const results = await Promise.all(commands.map((command) => runAsync(command)));
        return Response.json(results.map((result) => ({ result })));
      }
      return Response.json({ result: await runAsync(url.pathname.split("/").slice(1).map(decodeURIComponent)) });
    },
  };
}

test("concurrent forgot requests reuse one valid code instead of invalidating the later email", async (t) => {
  const previousUrl = process.env.KV_REST_API_URL;
  const previousToken = process.env.KV_REST_API_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.KV_REST_API_URL = "https://redis.invalid";
  process.env.KV_REST_API_TOKEN = "test-token";
  let storedCode = "";
  let calls = 0;

  globalThis.fetch = async (input) => {
    calls += 1;
    const parts = new URL(String(input)).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    assert.equal(parts[0], "EVAL");
    const proposedCode = parts[4];
    if (!storedCode) storedCode = proposedCode;
    return Response.json({ result: storedCode });
  };

  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = previousToken;
  });

  const [first, second] = await Promise.all([
    getOrCreateResetCode("old@example.com", "123456", 600),
    getOrCreateResetCode("old@example.com", "654321", 600),
  ]);
  assert.equal(first, "123456");
  assert.equal(second, "123456");
  assert.equal(storedCode, "123456");
  assert.equal(calls, 2);
  assert.equal(await getOrCreateResetCode("old@example.com", "12.5", 600), null);
  assert.equal(calls, 2, "invalid codes must not touch Redis");
});

test("real Redis atomically reuses and renews reset codes while repairing malformed legacy keys", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-reset-code-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const previousUrl = process.env.KV_REST_API_URL;
  const previousToken = process.env.KV_REST_API_TOKEN;
  const previousResendKey = process.env.RESEND_API_KEY;
  const previousProvider = process.env.EMAIL_PROVIDER;
  const previousMailFrom = process.env.MAIL_FROM;
  const previousTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousTelegramChat = process.env.TELEGRAM_CHAT_ID;
  const previousFetch = globalThis.fetch;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Redis container did not become ready");
    const redis = realRedis(container);
    process.env.KV_REST_API_URL = "https://redis.reset-code.test";
    process.env.KV_REST_API_TOKEN = "test-token";
    process.env.RESEND_API_KEY = "re_forgot_route_test";
    process.env.EMAIL_PROVIDER = "resend";
    process.env.MAIL_FROM = "info@liumeiti.vip";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    let mailCalls = 0;
    globalThis.fetch = async (input, init = {}) => {
      if (String(input) === "https://api.resend.com/emails") {
        mailCalls += 1;
        return Response.json({ id: `forgot-mail-${mailCalls}` });
      }
      return redis.fetch(input, init);
    };

    const concurrentKey = "liumeiti:reset:concurrent@example.com";
    const concurrent = await Promise.all([
      getOrCreateResetCode("concurrent@example.com", "111111", 600),
      getOrCreateResetCode("concurrent@example.com", "222222", 600),
      getOrCreateResetCode("concurrent@example.com", "333333", 600),
    ]);
    assert.ok(concurrent.every((code) => code === concurrent[0]));
    assert.ok(["111111", "222222", "333333"].includes(concurrent[0]));
    assert.equal(redis.run(["GET", concurrentKey]), concurrent[0]);
    assert.ok(Number(redis.run(["TTL", concurrentKey])) >= 595);

    const criticalKey = "liumeiti:reset:critical@example.com";
    redis.run(["SET", criticalKey, "444444", "EX", "5"]);
    const critical = await Promise.all([
      getOrCreateResetCode("critical@example.com", "555555", 600),
      getOrCreateResetCode("critical@example.com", "666666", 600),
    ]);
    assert.deepEqual(critical, ["444444", "444444"]);
    assert.equal(redis.run(["GET", criticalKey]), "444444");
    assert.ok(Number(redis.run(["TTL", criticalKey])) >= 595, "a valid near-expiry code must renew to the full advertised lifetime");

    const malformedKey = "liumeiti:reset:malformed@example.com";
    redis.run(["SET", malformedKey, "malformed", "EX", "100"]);
    assert.equal(await getOrCreateResetCode("malformed@example.com", "333333", 600), "333333");
    assert.equal(redis.run(["GET", malformedKey]), "333333");

    const wrongTypeKey = "liumeiti:reset:wrongtype@example.com";
    redis.run(["HSET", wrongTypeKey, "legacy", "value"]);
    assert.equal(await getOrCreateResetCode("wrongtype@example.com", "444444", 600), "444444");
    assert.equal(redis.run(["TYPE", wrongTypeKey]), "string");
    assert.equal(redis.run(["GET", wrongTypeKey]), "444444");

    const legacyEmail = "legacy-forgot@example.com";
    const legacyUserKey = `liumeiti:users:${legacyEmail}`;
    const legacyBalanceKey = `${legacyUserKey}:balance:cents`;
    const legacyVersionKey = `lm:user:authver:${legacyEmail}`;
    const legacyLifecycleKey = `lm:user:lifecycle:${legacyEmail}`;
    redis.run(["SET", legacyUserKey, JSON.stringify({
      email: legacyEmail,
      passwordHash: "legacy-password-hash",
      balance: 12.5,
      coupons: [],
      withdrawals: [],
    })]);
    redis.run(["SET", legacyBalanceKey, "12.5"]);
    redis.run(["SET", legacyVersionKey, ""]);

    const forgotResponse = await forgotPassword(new Request("https://www.liumeiti.vip/api/auth/forgot", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.21" },
      body: JSON.stringify({ email: legacyEmail }),
    }));
    assert.equal(forgotResponse.status, 200);
    assert.deepEqual(await forgotResponse.json(), { ok: true, accepted: true });
    assert.equal(mailCalls, 1, "a repairable historical account must receive its reset email");
    assert.equal(redis.run(["GET", legacyBalanceKey]), null, "malformed balance shadow must be deleted");
    assert.equal(redis.run(["GET", legacyVersionKey]), "1", "malformed auth version must be repaired");
    assert.match(redis.run(["GET", legacyLifecycleKey]), /^[a-f0-9]{32}$/, "missing lifecycle must be created");
    assert.match(redis.run(["GET", `liumeiti:reset:${legacyEmail}`]), /^\d{6}$/);
    assert.ok(Number(redis.run(["TTL", `liumeiti:reset:${legacyEmail}`])) > 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = previousToken;
    if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendKey;
    if (previousProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = previousProvider;
    if (previousMailFrom === undefined) delete process.env.MAIL_FROM;
    else process.env.MAIL_FROM = previousMailFrom;
    if (previousTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousTelegramToken;
    if (previousTelegramChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previousTelegramChat;
    docker(["rm", "-f", container]);
  }
});

test("forgot response avoids false delivery claims and clients require the accepted contract", async () => {
  const route = await readFile(new URL("../app/api/auth/forgot/route.js", import.meta.url), "utf8");
  const utils = await readFile(new URL("../app/api/_utils.js", import.meta.url), "utf8");
  assert.match(route, /getOrCreateResetCode\(email, generateCode\(\), 600\)/);
  assert.match(route, /readUserAuthState\(email\)/);
  assert.doesNotMatch(route, /\bgetUser\(email\)/);
  assert.match(route, /return Response\.json\(\{ ok: true, accepted: true \}\)/);
  assert.doesNotMatch(route, /return Response\.json\(\{ ok: true, sent: true \}\)/);
  assert.match(route, /有效期 10 分钟/);
  assert.match(route, /Valid for 10 minutes/);
  const script = utils.slice(utils.indexOf("const GET_OR_CREATE_RESET_CODE_SCRIPT"), utils.indexOf("export async function getOrCreateResetCode"));
  assert.match(script, /redis\.call\('TYPE',KEYS\[1\]\)/);
  assert.match(script, /keyType~='none' and keyType~='string'[\s\S]*redis\.call\('DEL',KEYS\[1\]\)/);
  assert.match(script, /existing and string\.match\(existing,'\^%d%d%d%d%d%d\$'\)[\s\S]*redis\.call\('EXPIRE',KEYS\[1\],ARGV\[2\]\)[\s\S]*return existing/);

  for (const relative of [
    "../app/account/page.jsx",
    "../app/checkout/page.jsx",
    "../app/service-center/page.jsx",
    "../app/components/RedeemCard.jsx",
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.match(source, /isSuccessfulAuthResponse\(res, data, attemptedMode\)/);
    assert.match(source, /如果该邮箱已注册，验证码会发送至邮箱/);
  }
});
