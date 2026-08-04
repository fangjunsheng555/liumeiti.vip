import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { NextRequest } from "../node_modules/next/server.js";

process.env.AUTH_SECRET = "admin-session-revocation-test-secret";
process.env.KV_REST_API_URL = "https://redis.admin-session.test";
process.env.KV_REST_API_TOKEN = "test-token";

const utils = await import("../app/api/_utils.js");
const loginRoute = await import("../app/api/admin/login/route.js");
const staffRoute = await import("../app/api/admin/staff/[id]/route.js");

const STAFF_KEY = "liumeiti:admin:staff";
const kickKey = (id) => `lm:staff:kick:${id}`;
const issueFenceKey = (id) => `lm:staff:issue-fence:${id}`;
const twoFaKey = (id) => `lm:staff:2fa:${id}`;

function currentTotp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of String(secret)) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function realRedis(container) {
  const run = (command) => {
    const child = docker(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis-cli failed");
    const output = child.stdout.trim();
    return output ? JSON.parse(output) : null;
  };
  return {
    run,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/pipeline") {
        const commands = JSON.parse(String(init.body || "[]"));
        const rows = [];
        for (const command of commands) {
          try { rows.push({ result: run(command) }); }
          catch (error) { rows.push({ error: String(error?.message || error) }); }
        }
        return Response.json(rows);
      }
      const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
      try { return Response.json({ result: run(command) }); }
      catch (error) { return Response.json({ error: String(error?.message || error) }); }
    },
  };
}

async function withFetch(fetchImpl, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await callback(); } finally { globalThis.fetch = original; }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFakeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  const state = {
    failGet: false,
    failGetKeys: new Set(),
    failEval: false,
    conflictOnce: false,
    beforeKickGet: null,
    deferredStaffMutation: null,
    evalCommands: [],
  };
  const strictRateLimitResult = (keys, args) => {
    const identityCount = Number(store.get(keys[0]) || 0) + 1;
    const ipCount = Number(store.get(keys[1]) || 0) + 1;
    store.set(keys[0], String(identityCount));
    store.set(keys[1], String(ipCount));
    return JSON.stringify({
      ok: true,
      identityCount,
      ipCount,
      identityTtl: Number(args[0]) || 600,
      ipTtl: Number(args[0]) || 600,
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/pipeline") {
      const commands = JSON.parse(String(options.body || "[]"));
      const isEval = commands.length === 1 && commands[0]?.[0] === "EVAL";
      if (isEval && state.failEval) return jsonResponse({ error: "redis_down" }, 503);
      const deferred = state.deferredStaffMutation;
      if (
        isEval && deferred && !deferred.started
        && String(commands[0]?.[1] || "").includes("staff_concurrent_update")
      ) {
        deferred.started = true;
        deferred.command = commands[0];
        deferred.markStarted({ proposed: Number(commands[0][commands[0].length - 1]) });
        await deferred.releasePromise;
      }
      const rows = commands.map((command) => {
        if (command[0] !== "EVAL") return { result: "OK" };
        state.evalCommands.push(command);
        const script = String(command[1] || "");
        const keyCount = Number(command[2] || 0);
        const keys = command.slice(3, 3 + keyCount);
        const args = command.slice(3 + keyCount);

        if (script.includes("identityCount=redis.call('INCR',KEYS[1])")) {
          return { result: strictRateLimitResult(keys, args) };
        }

        if (script.includes("admin_2fa_backup_consume_lossless_v2")) {
          const raw = store.get(keys[0]);
          if (raw == null) return { result: ["error", "not_enabled"] };
          if (raw !== args[1]) return { result: ["stale"] };
          let record = null;
          try { record = JSON.parse(raw); } catch (error) {}
          if (!record || typeof record.secretEnc !== "string" || !Array.isArray(record.backupHashes)) {
            return { result: ["error", "invalid_storage_response"] };
          }
          const index = record.backupHashes.indexOf(args[0]);
          if (index < 0) return { result: ["error", "invalid_code"] };
          const replacement = JSON.parse(args[2]);
          store.set(keys[0], args[2]);
          return { result: ["ok", String(replacement.backupHashes.length)] };
        }

        if (script.includes("staff_concurrent_update")) {
          if (state.conflictOnce) {
            state.conflictOnce = false;
            const concurrent = JSON.parse(store.get(keys[0]));
            concurrent[0].remark = "concurrent edit";
            store.set(keys[0], JSON.stringify(concurrent));
          }
          const current = store.get(keys[0]);
          const expected = args[0] === "__LM_ADMIN_STAFF_ABSENT__" ? undefined : args[0];
          if (current !== expected) {
            return { result: JSON.stringify({ ok: false, error: "staff_concurrent_update" }) };
          }
          const currentKick = Number(store.get(keys[1]) || 0);
          const issueFence = Number(store.get(keys[2]) || 0);
          const kickTs = Math.max(Number(args[2]), issueFence, currentKick + 1);
          store.set(keys[0], args[1]);
          store.set(keys[1], String(kickTs));
          return { result: JSON.stringify({ ok: true, kickTs }) };
        }

        if (script.includes("admin_session_issue_fence_v1")) {
          const currentKick = Number(store.get(keys[0]) || 0);
          if (currentKick !== Number(args[0])) {
            return { result: JSON.stringify({ ok: false, error: "session_state_changed", kickTs: currentKick }) };
          }
          const currentFence = Number(store.get(keys[1]) || 0);
          const issuedAt = Math.max(Number(args[1]), currentKick + 1, currentFence + 1);
          store.set(keys[1], String(issuedAt));
          return { result: JSON.stringify({ ok: true, issuedAt, kickTs: currentKick }) };
        }

        if (script.includes("issuedAt=tonumber")) {
          const currentKick = Number(store.get(keys[0]) || 0);
          const issueFence = Number(store.get(keys[1]) || 0);
          const issuedAt = Number(args[0]);
          if (currentKick > 0 && issuedAt <= currentKick) {
            return { result: JSON.stringify({ ok: false, error: "session_revoked", kickTs: currentKick }) };
          }
          const kickTs = Math.max(Number(args[1]), issuedAt, issueFence, currentKick + 1);
          store.set(keys[0], String(kickTs));
          return { result: JSON.stringify({ ok: true, kickTs }) };
        }

        const clearing2fa = script.includes("redis.call('DEL',KEYS[1])");
        const kickIndex = clearing2fa ? 1 : 0;
        const fenceIndex = clearing2fa ? 2 : 1;
        const currentKick = Number(store.get(keys[kickIndex]) || 0);
        const issueFence = Number(store.get(keys[fenceIndex]) || 0);
        const proposed = Number(args[0]);
        const kickTs = Math.max(proposed, issueFence, currentKick + 1);
        if (clearing2fa) store.delete(keys[0]);
        store.set(keys[kickIndex], String(kickTs));
        return { result: JSON.stringify({ ok: true, kickTs }) };
      });
      if (deferred?.started && deferred.command === commands[0]) deferred.markCommitted();
      return jsonResponse(rows);
    }

    const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const op = String(parts[0] || "").toUpperCase();
    if (op === "GET") {
      if (state.failGet || state.failGetKeys.has(parts[1])) return jsonResponse({ error: "redis_down" }, 503);
      if (parts[1]?.startsWith("lm:staff:kick:") && state.beforeKickGet) {
        const hook = state.beforeKickGet;
        state.beforeKickGet = null;
        hook(store, parts[1]);
      }
      return jsonResponse({ result: store.get(parts[1]) ?? null });
    }
    if (op === "EVAL") {
      const script = String(parts[1] || "");
      const keyCount = Number(parts[2] || 0);
      const keys = parts.slice(3, 3 + keyCount);
      const args = parts.slice(3 + keyCount);
      if (script.includes("identityCount=redis.call('INCR',KEYS[1])")) {
        return jsonResponse({ result: strictRateLimitResult(keys, args) });
      }
    }
    return jsonResponse({ result: null });
  };
  return {
    store,
    state,
    restore() { globalThis.fetch = originalFetch; },
  };
}

function deferNextStaffMutation(state) {
  let release;
  let markStarted;
  let markCommitted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const committed = new Promise((resolve) => { markCommitted = resolve; });
  state.deferredStaffMutation = {
    started: false,
    command: null,
    markStarted,
    markCommitted,
    releasePromise: new Promise((resolve) => { release = resolve; }),
  };
  return { started, committed, release };
}

async function loadMiddleware() {
  let source = await fs.readFile(new URL("../proxy.js", import.meta.url), "utf8");
  const nextServerUrl = pathToFileURL(process.cwd() + "/node_modules/next/server.js").href;
  source = source.replace('from "next/server"', `from ${JSON.stringify(nextServerUrl)}`);
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}

function adminRequest(path, token, method = "GET") {
  return new NextRequest(`https://www.liumeiti.vip${path}`, {
    method,
    headers: { cookie: `lm_admin=${encodeURIComponent(token)}` },
  });
}

test("admin logout durably revokes a copied JWT before clearing the cookie", async (t) => {
  const redis = installFakeRedis();
  t.after(() => redis.restore());
  const { proxy: middleware } = await loadMiddleware();
  const issuedAt = Date.now() - 1_000;
  const copiedToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "root",
    iat: issuedAt,
    exp: Date.now() + 60_000,
  });

  const logout = await loginRoute.DELETE(new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "DELETE",
    headers: { cookie: `lm_admin=${encodeURIComponent(copiedToken)}` },
  }));
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).revoked, true);
  assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/);
  assert.ok(Number(redis.store.get(kickKey(1))) >= issuedAt);
  const persistedBoundary = redis.store.get(kickKey(1));

  const repeatedLogout = await loginRoute.DELETE(new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "DELETE",
    headers: { cookie: `lm_admin=${encodeURIComponent(copiedToken)}` },
  }));
  assert.equal(repeatedLogout.status, 401);
  assert.equal(redis.store.get(kickKey(1)), persistedBoundary);

  const replay = await middleware(adminRequest("/api/admin/health", copiedToken));
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), { ok: false, error: "session_revoked" });
  assert.match(replay.headers.get("set-cookie") || "", /lm_admin=/);
  const diagnosticReplay = await middleware(adminRequest("/api/test-email", copiedToken, "POST"));
  assert.equal(diagnosticReplay.status, 401);
});

test("admin kick lookup outages warn and fail open by default while durable auth operations stay strict", async (t) => {
  const redis = installFakeRedis();
  t.after(() => redis.restore());
  const previousKickPolicy = process.env.ADMIN_KICK_CHECK_FAIL_CLOSED;
  delete process.env.ADMIN_KICK_CHECK_FAIL_CLOSED;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => {
    console.warn = originalWarn;
    if (previousKickPolicy === undefined) delete process.env.ADMIN_KICK_CHECK_FAIL_CLOSED;
    else process.env.ADMIN_KICK_CHECK_FAIL_CLOSED = previousKickPolicy;
  });
  const previousAdminUsername = process.env.ADMIN_USERNAME;
  const previousAdminPassword = process.env.ADMIN_PASSWORD;
  const previous2faDisable = process.env.ADMIN_2FA_DISABLE;
  process.env.ADMIN_USERNAME = "root-admin";
  process.env.ADMIN_PASSWORD = "root-password-strong";
  process.env.ADMIN_2FA_DISABLE = "1";
  t.after(() => {
    if (previousAdminUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previousAdminUsername;
    if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousAdminPassword;
    if (previous2faDisable === undefined) delete process.env.ADMIN_2FA_DISABLE;
    else process.env.ADMIN_2FA_DISABLE = previous2faDisable;
  });
  const { proxy: middleware } = await loadMiddleware();
  const token = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "root",
    iat: Date.now(),
    exp: Date.now() + 60_000,
  });

  redis.state.failGet = true;
  const protectedResponse = await middleware(adminRequest("/api/admin/health", token));
  assert.equal(protectedResponse.status, 200);
  assert.equal(protectedResponse.headers.get("x-middleware-next"), "1");
  const loginLogResponse = await middleware(adminRequest("/api/admin/login-log", token));
  assert.equal(loginLogResponse.status, 200);
  const diagnosticResponse = await middleware(adminRequest("/api/test-email", token, "POST"));
  assert.equal(diagnosticResponse.status, 200);
  assert.ok(warnings.some((entry) => entry.includes("admin_session_revocation_check_unavailable")));
  assert.ok(warnings.some((entry) => entry.includes("redis_http_error")));

  const loginWhileConfiguredStoreIsDown = await loginRoute.POST(new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "root-admin", password: "root-password-strong" }),
  }));
  assert.equal(loginWhileConfiguredStoreIsDown.status, 503);
  assert.equal(loginWhileConfiguredStoreIsDown.headers.get("set-cookie"), null);

  redis.state.failGet = false;
  const redisToken = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_TOKEN;
  const partialConfigResponse = await middleware(adminRequest("/api/admin/health", token));
  assert.equal(partialConfigResponse.status, 200);
  assert.equal(partialConfigResponse.headers.get("x-middleware-next"), "1");
  process.env.KV_REST_API_TOKEN = redisToken;

  const redisUrl = process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  const missingConfigResponse = await middleware(adminRequest("/api/admin/health", token));
  assert.equal(missingConfigResponse.status, 200);
  assert.equal(missingConfigResponse.headers.get("x-middleware-next"), "1");
  assert.ok(warnings.some((entry) => entry.includes("redis_configuration_missing")));
  const missingConfigLogin = await loginRoute.POST(new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "root-admin", password: "root-password-strong" }),
  }));
  assert.equal(missingConfigLogin.status, 503);
  process.env.ADMIN_KICK_CHECK_FAIL_CLOSED = "1";
  const explicitlyStrictResponse = await middleware(adminRequest("/api/admin/health", token));
  assert.equal(explicitlyStrictResponse.status, 503);
  assert.deepEqual(await explicitlyStrictResponse.json(), {
    ok: false,
    error: "session_store_unavailable",
  });
  delete process.env.ADMIN_KICK_CHECK_FAIL_CLOSED;
  process.env.KV_REST_API_URL = redisUrl;
  process.env.KV_REST_API_TOKEN = redisToken;

  const loginResponse = await middleware(adminRequest("/api/admin/login", token, "POST"));
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.headers.get("x-middleware-next"), "1");

  const rootLogin = await loginRoute.POST(new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "root-admin", password: "root-password-strong" }),
  }));
  assert.equal(rootLogin.status, 200);
  assert.match(rootLogin.headers.get("set-cookie") || "", /lm_admin=/);

  redis.state.failEval = true;
  const logout = await loginRoute.DELETE(new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "DELETE",
    headers: { cookie: `lm_admin=${encodeURIComponent(token)}` },
  }));
  assert.equal(logout.status, 503);
  assert.equal(logout.headers.get("set-cookie"), null);
  assert.equal((await logout.json()).error, "session_revocation_unavailable");

  const kickFailure = await staffRoute.PATCH(new Request("https://www.liumeiti.vip/api/admin/staff/2", {
    method: "PATCH",
    headers: {
      cookie: `lm_admin=${encodeURIComponent(token)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "kick" }),
  }), { params: Promise.resolve({ id: "2" }) });
  assert.equal(kickFailure.status, 503);
  assert.equal((await kickFailure.json()).error, "kick_failed");
});

test("staff record changes and their session revocation commit atomically", async (t) => {
  const original = [{
    id: 2,
    username: "operator2",
    role: "operator",
    active: true,
    remark: "original",
    passwordHash: utils.hashPassword("old-password"),
  }];
  const redis = installFakeRedis({ [STAFF_KEY]: JSON.stringify(original) });
  t.after(() => redis.restore());
  redis.state.conflictOnce = true;

  const updated = await utils.updateAdminStaff(2, { role: "finance" }, { staffId: 1, staffUsername: "root" });
  assert.equal(updated.ok, true);
  const recordsAfterUpdate = JSON.parse(redis.store.get(STAFF_KEY));
  assert.equal(recordsAfterUpdate[0].role, "finance");
  assert.equal(recordsAfterUpdate[0].remark, "concurrent edit");
  assert.ok(Number(redis.store.get(kickKey(2))) > 0);
  assert.ok(redis.state.evalCommands.every((command) => command.slice(3, 5).includes(STAFF_KEY)));

  const beforeFailedChange = redis.store.get(STAFF_KEY);
  const beforeFailedKick = redis.store.get(kickKey(2));
  redis.state.failEval = true;
  const rootToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "root",
    iat: Date.now(),
    exp: Date.now() + 60_000,
  });
  const failed = await staffRoute.PATCH(new Request("https://www.liumeiti.vip/api/admin/staff/2", {
    method: "PATCH",
    headers: {
      cookie: `lm_admin=${encodeURIComponent(rootToken)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ active: false }),
  }), { params: Promise.resolve({ id: "2" }) });
  assert.equal(failed.status, 503);
  assert.equal(redis.store.get(STAFF_KEY), beforeFailedChange);
  assert.equal(redis.store.get(kickKey(2)), beforeFailedKick);

  redis.state.failEval = false;
  const deleted = await utils.deleteAdminStaff(2, { staffId: 1, staffUsername: "root" });
  assert.equal(deleted.ok, true);
  assert.deepEqual(JSON.parse(redis.store.get(STAFF_KEY)), []);
  assert.ok(Number(redis.store.get(kickKey(2))) > Number(beforeFailedKick));
});

test("a permission change racing login cannot mint a fresh stale-privilege JWT", async (t) => {
  const staff = [{
    id: 2,
    username: "operator2",
    role: "operator",
    active: true,
    perms: { canViewUsers: false },
    passwordHash: utils.hashPassword("operator-password"),
  }];
  const redis = installFakeRedis({ [STAFF_KEY]: JSON.stringify(staff) });
  t.after(() => redis.restore());
  redis.state.beforeKickGet = (store, key) => {
    const changed = JSON.parse(store.get(STAFF_KEY));
    changed[0].role = "finance";
    changed[0].perms = { canViewUsers: true };
    store.set(STAFF_KEY, JSON.stringify(changed));
    store.set(key, String(Date.now()));
  };

  const response = await loginRoute.POST(new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator2", password: "operator-password" }),
  }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") || "";
  const encoded = cookie.match(/lm_admin=([^;]+)/)?.[1] || "";
  const session = utils.verifySession(decodeURIComponent(encoded));
  assert.equal(session.staffRole, "finance");
  assert.equal(session.staffPerms.canViewUsers, true);
  assert.ok(session.iat > Number(redis.store.get(kickKey(2))));
});

test("a mutation before the issuance reservation makes login fail closed", async (t) => {
  const staff = [{
    id: 2,
    username: "operator-gap",
    role: "operator",
    active: true,
    perms: { canViewUsers: false },
    passwordHash: utils.hashPassword("operator-password"),
  }];
  const redis = installFakeRedis({ [STAFF_KEY]: JSON.stringify(staff) });
  t.after(() => redis.restore());
  const request = new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator-gap", password: "operator-password" }),
  });
  Object.defineProperty(request, Symbol.for("liumeiti.admin.login.after-stable-snapshot"), {
    value: async ({ issuedAt }) => {
      redis.store.set(STAFF_KEY, "[]");
      redis.store.set(kickKey(2), String(Math.max(Number(issuedAt), Date.now())));
    },
  });

  const response = await loginRoute.POST(request);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "session_state_changed");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(JSON.parse(redis.store.get(STAFF_KEY)), []);
});

test("a mutation carrying old t0 but committing after issuance cannot preserve the stale token", async (t) => {
  const staff = [{
    id: 2,
    username: "operator-delayed",
    role: "operator",
    active: true,
    perms: { canViewUsers: false },
    passwordHash: utils.hashPassword("operator-password"),
  }];
  const redis = installFakeRedis({ [STAFF_KEY]: JSON.stringify(staff) });
  t.after(() => redis.restore());
  const { proxy: middleware } = await loadMiddleware();
  const delayed = deferNextStaffMutation(redis.state);
  const mutationPromise = utils.updateAdminStaff(
    2,
    { role: "finance", perms: { canViewUsers: true } },
    { staffId: 1, staffUsername: "root" },
  );
  const captured = await delayed.started;

  const request = new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator-delayed", password: "operator-password" }),
  });
  Object.defineProperty(request, Symbol.for("liumeiti.admin.login.after-issuance-reservation"), {
    value: async ({ issuedAt }) => {
      assert.ok(captured.proposed <= issuedAt, "the mutation must carry the older process timestamp");
      delayed.release();
      await delayed.committed;
    },
  });

  const response = await loginRoute.POST(request);
  const mutation = await mutationPromise;
  assert.equal(response.status, 200);
  assert.equal(mutation.ok, true);
  const encoded = (response.headers.get("set-cookie") || "").match(/lm_admin=([^;]+)/)?.[1] || "";
  const token = decodeURIComponent(encoded);
  const session = utils.verifySession(token);
  assert.equal(session.staffRole, "operator");
  assert.ok(session.iat <= Number(redis.store.get(kickKey(2))));
  assert.equal(Number(redis.store.get(kickKey(2))), Number(redis.store.get(issueFenceKey(2))));

  const replay = await middleware(adminRequest("/api/admin/health", token));
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), { ok: false, error: "session_revoked" });
});

test("concurrent logins can consume one backup code only once", async (t) => {
  const previous2faDisable = process.env.ADMIN_2FA_DISABLE;
  process.env.ADMIN_2FA_DISABLE = "0";
  t.after(() => {
    if (previous2faDisable === undefined) delete process.env.ADMIN_2FA_DISABLE;
    else process.env.ADMIN_2FA_DISABLE = previous2faDisable;
  });
  const staff = [{
    id: 2,
    username: "operator-2fa",
    role: "operator",
    active: true,
    passwordHash: utils.hashPassword("operator-password"),
  }];
  const secret = utils.generateTotpSecret();
  // This backup code contains the currently valid six TOTP digits. The login
  // verifier must not strip its letters and treat it as a reusable TOTP.
  const backupCode = `AB${currentTotp(secret)}CD`;
  const backupHash = createHash("sha256").update("backup|" + backupCode).digest("hex");
  const twoFaRecord = {
    secretEnc: utils.encryptTotpSecret(secret),
    backupHashes: [backupHash],
  };
  const redis = installFakeRedis({
    [STAFF_KEY]: JSON.stringify(staff),
    [twoFaKey(2)]: JSON.stringify(twoFaRecord),
  });
  t.after(() => redis.restore());
  const login = () => loginRoute.POST(new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "operator-2fa",
      password: "operator-password",
      otp: backupCode,
    }),
  }));

  const responses = await Promise.all([login(), login()]);
  assert.deepEqual(responses.map((response) => response.status).sort((a, b) => a - b), [200, 401]);
  assert.equal(responses.filter((response) => (response.headers.get("set-cookie") || "").includes("lm_admin=")).length, 1);
  const failed = responses.find((response) => response.status === 401);
  assert.equal((await failed.json()).error, "invalid_2fa");
  const stored = JSON.parse(redis.store.get(twoFaKey(2)));
  assert.deepEqual(stored.backupHashes, []);
});

test("2FA storage read and backup-code write failures fail login closed", async (t) => {
  const previous2faDisable = process.env.ADMIN_2FA_DISABLE;
  process.env.ADMIN_2FA_DISABLE = "0";
  t.after(() => {
    if (previous2faDisable === undefined) delete process.env.ADMIN_2FA_DISABLE;
    else process.env.ADMIN_2FA_DISABLE = previous2faDisable;
  });
  const staff = [{
    id: 2,
    username: "operator-2fa-failure",
    role: "operator",
    active: true,
    passwordHash: utils.hashPassword("operator-password"),
  }];
  const { codes, hashes } = utils.generateBackupCodes();
  const storedRecord = JSON.stringify({
    secretEnc: utils.encryptTotpSecret(utils.generateTotpSecret()),
    backupHashes: [hashes[0]],
  });
  const redis = installFakeRedis({
    [STAFF_KEY]: JSON.stringify(staff),
    [twoFaKey(2)]: storedRecord,
  });
  t.after(() => redis.restore());
  const login = () => loginRoute.POST(new Request("https://www.liumeiti.vip/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "operator-2fa-failure",
      password: "operator-password",
      otp: codes[0],
    }),
  }));

  redis.state.failGetKeys.add(twoFaKey(2));
  const readFailure = await login();
  assert.equal(readFailure.status, 503);
  assert.equal((await readFailure.json()).error, "two_factor_store_unavailable");
  assert.equal(readFailure.headers.get("set-cookie"), null);

  redis.state.failGetKeys.delete(twoFaKey(2));
  redis.state.failEval = true;
  const writeFailure = await login();
  assert.equal(writeFailure.status, 503);
  assert.equal((await writeFailure.json()).error, "two_factor_store_unavailable");
  assert.equal(writeFailure.headers.get("set-cookie"), null);
  assert.equal(redis.store.get(twoFaKey(2)), storedRecord);
});

test("real Redis executes monotonic revocation and atomic concurrent staff changes", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-admin-session-${process.pid}-${Date.now()}`;
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
    const redis = realRedis(container);
    const initial = [{
      id: 2,
      username: "operator2",
      role: "operator",
      active: true,
      remark: "original",
      passwordHash: utils.hashPassword("old-password"),
    }];
    redis.run(["SET", STAFF_KEY, JSON.stringify(initial)]);

    const [roleChange, remarkChange] = await withFetch(redis.fetch, () => Promise.all([
      utils.updateAdminStaff(2, { role: "finance" }, { staffId: 1, staffUsername: "root" }),
      utils.updateAdminStaff(2, { remark: "kept after CAS retry" }, { staffId: 1, staffUsername: "root" }),
    ]));
    assert.equal(roleChange.ok, true);
    assert.equal(remarkChange.ok, true);
    const after = JSON.parse(redis.run(["GET", STAFF_KEY]));
    assert.equal(after[0].role, "finance");
    assert.equal(after[0].remark, "kept after CAS retry");
    const staffKick = Number(redis.run(["GET", kickKey(2)]));
    assert.ok(staffKick > 0);

    let releaseDelayedMutation;
    let markDelayedCaptured;
    const delayedCaptured = new Promise((resolve) => { markDelayedCaptured = resolve; });
    const delayedGate = new Promise((resolve) => { releaseDelayedMutation = resolve; });
    let delayedOnce = true;
    const delayedFetch = async (input, init = {}) => {
      if (delayedOnce && new URL(String(input)).pathname === "/pipeline") {
        const commands = JSON.parse(String(init.body || "[]"));
        if (String(commands[0]?.[1] || "").includes("staff_concurrent_update")) {
          delayedOnce = false;
          markDelayedCaptured(Number(commands[0][commands[0].length - 1]));
          await delayedGate;
        }
      }
      return redis.fetch(input, init);
    };
    await withFetch(delayedFetch, async () => {
      const lateMutation = utils.updateAdminStaff(
        2,
        { role: "support" },
        { staffId: 1, staffUsername: "root" },
      );
      const oldProposed = await delayedCaptured;
      const beforeReservationKick = Number(redis.run(["GET", kickKey(2)]));
      const reservation = await utils.reserveAdminSessionIssuance(
        2,
        beforeReservationKick,
        Math.max(Date.now(), oldProposed + 1),
      );
      assert.equal(reservation.ok, true);
      assert.ok(oldProposed < reservation.issuedAt);
      releaseDelayedMutation();
      assert.equal((await lateMutation).ok, true);
      assert.ok(Number(redis.run(["GET", kickKey(2)])) >= reservation.issuedAt);
      assert.equal(Number(redis.run(["GET", issueFenceKey(2)])), reservation.issuedAt);
    });

    const tokenIat = Number(redis.run(["GET", kickKey(2)])) + 1;
    const revoked = await withFetch(redis.fetch, () => utils.revokeAdminSession(2, tokenIat, tokenIat));
    assert.equal(revoked.ok, true);
    const boundary = redis.run(["GET", kickKey(2)]);
    const repeated = await withFetch(redis.fetch, () => utils.revokeAdminSession(2, tokenIat, tokenIat + 1));
    assert.deepEqual(repeated, { ok: false, error: "session_revoked" });
    assert.equal(redis.run(["GET", kickKey(2)]), boundary);

    const { codes, hashes } = utils.generateBackupCodes();
    const twoFaLosslessRaw = JSON.stringify({
      secretEnc: utils.encryptTotpSecret(utils.generateTotpSecret()),
      backupHashes: [hashes[0]],
      legacyRows: [],
      legacyNull: null,
    }).replace(/}$/, ',"legacyHuge":123456789012345678901234567890}');
    redis.run(["SET", twoFaKey(2), twoFaLosslessRaw]);
    const backupAttempts = await withFetch(redis.fetch, () => Promise.all([
      utils.verifyStaff2faCode(2, codes[0]),
      utils.verifyStaff2faCode(2, codes[0]),
    ]));
    assert.equal(backupAttempts.filter((attempt) => attempt.ok).length, 1);
    assert.equal(backupAttempts.filter((attempt) => !attempt.ok && attempt.error === "invalid_code").length, 1);
    const twoFaAfterRaw = redis.run(["GET", twoFaKey(2)]);
    const twoFaAfter = JSON.parse(twoFaAfterRaw);
    assert.deepEqual(twoFaAfter.backupHashes, []);
    assert.match(twoFaAfterRaw, /"legacyRows":\[\]/);
    assert.match(twoFaAfterRaw, /"legacyNull":null/);
    assert.match(twoFaAfterRaw, /"legacyHuge":123456789012345678901234567890/);
    const strictState = await withFetch(redis.fetch, () => utils.getStaff2faState(2));
    assert.equal(strictState.ok, true);
    assert.deepEqual(strictState.record.backupHashes, []);

    const beforeTypeFailure = redis.run(["GET", STAFF_KEY]);
    redis.run(["DEL", kickKey(2)]);
    redis.run(["LPUSH", kickKey(2), "wrong-type"]);
    const failed = await withFetch(redis.fetch, () => utils.updateAdminStaff(
      2,
      { active: false },
      { staffId: 1, staffUsername: "root" },
    ));
    assert.equal(failed.ok, false);
    assert.equal(redis.run(["GET", STAFF_KEY]), beforeTypeFailure);
  } finally {
    docker(["rm", "-f", container]);
  }
});
