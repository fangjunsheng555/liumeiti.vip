import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.AUTH_SECRET = "auth-session-test-secret-0123456789abcdef";
process.env.KV_REST_API_URL = "https://redis.auth-session.test";
process.env.KV_REST_API_TOKEN = "test-token";

const utils = await import("../app/api/_utils.js");
const authSessions = await import("../app/api/_auth-session.js");
const meRoute = await import("../app/api/auth/me/route.js");
const loginRoute = await import("../app/api/auth/login/route.js");
const registerRoute = await import("../app/api/auth/register/route.js");
const resetRoute = await import("../app/api/auth/reset/route.js");
const balanceRoute = await import("../app/api/auth/balance/route.js");
const adminUserRoute = await import("../app/api/admin/users/[email]/route.js");
const adminNetflixRoute = await import("../app/api/admin/netflix-code/route.js");

const USER_KEY = "liumeiti:users:test@example.com";
const VERSION_KEY = "lm:user:authver:test@example.com";
const LIFECYCLE_KEY = "lm:user:lifecycle:test@example.com";
const BALANCE_KEY = "liumeiti:users:test@example.com:balance:cents";
const RESET_KEY = "liumeiti:reset:test@example.com";
const LEGACY_DEADLINE_KEY = "lm:auth:legacy-user-until:v2";

function requestWithToken(token) {
  return new Request("https://www.liumeiti.vip/api/auth/me", {
    headers: { cookie: `lm_user=${encodeURIComponent(token)}` },
  });
}

function redisResponse(result) {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function pipelineResponse(rows) {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

function installFakeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  const state = {
    afterAuthStateRead: null,
    afterProfileSave: null,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/pipeline" && String(options.method || "GET").toUpperCase() === "POST") {
      const commands = JSON.parse(String(options.body || "[]"));
      return pipelineResponse(commands.map((command) => {
        const pipelineOp = String(command[0] || "").toUpperCase();
        if (pipelineOp !== "EVAL") return { result: "OK" };
        const script = String(command[1] || "");
        const keyCount = Number(command[2] || 0);
        const keys = command.slice(3, 3 + keyCount);
        const args = command.slice(3 + keyCount);
        if (script.includes("READ_USER_AUTH_STATE_V2")) {
          const userRaw = store.get(keys[0]);
          if (!userRaw) return { result: JSON.stringify({ ok: false, error: "session_revoked" }) };
          const currentVersion = store.has(keys[1]) ? Number(store.get(keys[1])) : 1;
          const balanceCents = store.get(keys[2]) ?? null;
          const lifecycle = store.get(keys[3]) || args[0];
          if (!/^[a-f0-9]{32}$/.test(String(lifecycle || ""))) {
            return { result: JSON.stringify({ ok: false, error: "auth_record_invalid" }) };
          }
          if (!store.has(keys[1])) store.set(keys[1], String(currentVersion));
          if (!store.has(keys[3])) store.set(keys[3], lifecycle);
          if (typeof state.afterAuthStateRead === "function") {
            const hook = state.afterAuthStateRead;
            state.afterAuthStateRead = null;
            hook({ store, keys, values: [userRaw, String(currentVersion), balanceCents, lifecycle] });
          }
          return { result: JSON.stringify({
            ok: true,
            userRaw,
            authVersion: currentVersion,
            accountLifecycleId: lifecycle,
            balanceCents,
          }) };
        }
        if (script.includes("READ_SESSION_ISSUANCE_STATE") || script.includes("if versionType=='none' then redis.call('SET',KEYS[2],tostring(current)) end")) {
          const user = store.has(keys[0]) ? JSON.parse(store.get(keys[0])) : null;
          if (!user) return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          if (user.banned) return { result: JSON.stringify({ ok: false, error: "account_banned" }) };
          const currentVersion = store.has(keys[1]) ? Number(store.get(keys[1])) : 1;
          const expectedVersion = Number(args[0] || 0);
          if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
            return { result: JSON.stringify({ ok: false, error: "auth_record_invalid" }) };
          }
          if (expectedVersion > 0 && expectedVersion !== currentVersion) {
            return { result: JSON.stringify({ ok: false, error: "session_state_changed" }) };
          }
          const lifecycle = store.get(keys[3]) || args[2];
          if (!/^[a-f0-9]{32}$/.test(String(lifecycle || ""))) {
            return { result: JSON.stringify({ ok: false, error: "auth_record_invalid" }) };
          }
          if (!store.has(keys[1])) store.set(keys[1], String(currentVersion));
          if (!store.has(keys[3])) store.set(keys[3], lifecycle);
          return { result: JSON.stringify({ ok: true, authVersion: currentVersion, accountLifecycleId: lifecycle }) };
        }
        if (script.includes("redis.call('SREM',KEYS[4],ARGV[1])")) {
          const user = store.has(keys[0]) ? JSON.parse(store.get(keys[0])) : null;
          if (!user) return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          const currentVersion = store.has(keys[4]) ? Number(store.get(keys[4])) : 1;
          const authVersion = currentVersion + 1;
          store.set(keys[4], String(authVersion));
          store.delete(keys[0]);
          store.delete(keys[1]);
          store.delete(keys[2]);
          for (const index of [5, 6, 7, 8, 9, 11]) store.delete(keys[index]);
          return { result: JSON.stringify({
            ok: true,
            authVersion,
            user: {
              email: user.email || args[0],
              username: user.username || "",
              invitedByEmail: user.invitedByEmail || "",
              invitedBy2Email: user.invitedBy2Email || "",
              inviteCode: user.inviteCode || "",
            },
          }) };
        }
        if (script.includes("user.passwordHash=ARGV[1]")) {
          if (store.get(keys[2]) !== args[2]) {
            return { result: JSON.stringify({ ok: false, error: "code_invalid_or_expired" }) };
          }
          const user = store.has(keys[0]) ? JSON.parse(store.get(keys[0])) : null;
          if (!user) return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          const currentVersion = store.has(keys[1]) ? Number(store.get(keys[1])) : 1;
          user.passwordHash = args[0];
          user.passwordResetAt = args[1];
          store.set(keys[0], JSON.stringify(user));
          store.set(keys[1], String(currentVersion + 1));
          store.delete(keys[2]);
          return { result: JSON.stringify({ ok: true, authVersion: currentVersion + 1 }) };
        }
        if (script.includes("user.banned=target")) {
          const user = store.has(keys[0]) ? JSON.parse(store.get(keys[0])) : null;
          if (!user) return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          const target = args[0] === "1";
          const currentVersion = store.has(keys[1]) ? Number(store.get(keys[1])) : 1;
          if (Boolean(user.banned) === target) {
            return { result: JSON.stringify({ ok: true, changed: false, authVersion: currentVersion, banned: target }) };
          }
          user.banned = target;
          user.bannedAt = target ? args[1] : null;
          user.bannedByStaffId = target ? Number(args[2]) : null;
          user.unbannedByStaffId = target ? null : Number(args[2]);
          store.set(keys[0], JSON.stringify(user));
          store.set(keys[1], String(currentVersion + 1));
          return { result: JSON.stringify({ ok: true, changed: true, authVersion: currentVersion + 1, banned: target }) };
        }
        if (script.includes("canonical cents key is authoritative")) {
          const nextUser = JSON.parse(args[0]);
          const currentUser = store.has(keys[0]) ? JSON.parse(store.get(keys[0])) : null;
          if (args[2] === "1" && currentUser) {
            return { result: JSON.stringify({ ok: false, error: "user_exists" }) };
          }
          if (args[3] === "1" && !currentUser) {
            return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          }
          const currentVersion = store.has(keys[2]) ? Number(store.get(keys[2])) : 1;
          const expectedVersion = Number(args[1] || 0);
          if (expectedVersion > 0 && currentVersion !== expectedVersion) {
            return { result: JSON.stringify({ ok: false, error: "session_state_changed" }) };
          }
          const expectedLifecycle = String(args[6] || "");
          const currentLifecycle = currentUser ? String(store.get(keys[4]) || "") : "";
          if (expectedLifecycle && currentLifecycle !== expectedLifecycle) {
            return { result: JSON.stringify({ ok: false, error: "account_lifecycle_changed" }) };
          }
          const authoritativeCents = store.has(keys[1])
            ? Number(store.get(keys[1]))
            : Math.round(Number(currentUser?.balance ?? nextUser.balance ?? 0) * 100);
          store.set(keys[1], String(authoritativeCents));
          const merged = { ...nextUser };
          if (currentUser) {
            for (const field of [
              "passwordHash", "passwordResetAt", "banned", "bannedAt",
              "bannedByStaffId", "unbannedByStaffId", "coupons", "referralStats",
            ]) merged[field] = currentUser[field];
          }
          merged.balance = authoritativeCents / 100;
          store.set(keys[0], JSON.stringify(merged));
          const accountLifecycleId = currentUser ? (store.get(keys[4]) || args[5]) : args[5];
          store.set(keys[4], accountLifecycleId);
          if (typeof state.afterProfileSave === "function") {
            const hook = state.afterProfileSave;
            state.afterProfileSave = null;
            hook({ store, keys, args, user: merged, authVersion: currentVersion });
          }
          return { result: JSON.stringify({
            ok: true,
            balance: authoritativeCents / 100,
            balanceCents: authoritativeCents,
            authVersion: currentVersion,
            accountLifecycleId,
          }) };
        }
        return { error: "unsupported_test_script" };
      }));
    }
    const parts = parsedUrl.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const op = String(parts[0] || "").toUpperCase();
    if (op === "GET") return redisResponse(store.get(parts[1]) ?? null);
    if (op === "MGET") {
      const values = parts.slice(1).map((key) => store.get(key) ?? null);
      if (parts.includes(VERSION_KEY) && typeof state.afterAuthStateRead === "function") {
        const hook = state.afterAuthStateRead;
        state.afterAuthStateRead = null;
        hook({ store, keys: parts.slice(1), values });
      }
      return redisResponse(values);
    }
    if (op === "SET") {
      const [, key, pathValue, option] = parts;
      if (String(option || "").toUpperCase() === "NX" && store.has(key)) return redisResponse(null);
      store.set(key, pathValue === undefined ? String(options.body ?? "") : pathValue);
      return redisResponse("OK");
    }
    if (op === "DEL") {
      const existed = store.delete(parts[1]);
      return redisResponse(existed ? 1 : 0);
    }
    if (op === "PIPELINE") return redisResponse([]);
    if (op === "EVAL") {
      const script = String(parts[1] || "");
      const keyCount = Number(parts[2] || 0);
      const keys = parts.slice(3, 3 + keyCount);
      const args = parts.slice(3 + keyCount);
      if (script.includes("identityCount") && script.includes("ipCount")) {
        const identityCount = Number(store.get(keys[0]) || 0) + 1;
        const ipCount = Number(store.get(keys[1]) || 0) + 1;
        store.set(keys[0], String(identityCount));
        store.set(keys[1], String(ipCount));
        return redisResponse(JSON.stringify({
          ok: true,
          identityCount,
          ipCount,
          identityTtl: Number(args[2]),
          ipTtl: Number(args[2]),
        }));
      }
      if (script.includes("return 'consumed'")) {
        if (store.has(keys[0])) return redisResponse("used");
        store.set(keys[0], "1");
        return redisResponse("consumed");
      }
      const key = parts[3];
      const next = store.has(key) ? Number(store.get(key)) + 1 : 2;
      store.set(key, String(next));
      return redisResponse(next);
    }
    return redisResponse(null);
  };
  return {
    store,
    state,
    restore() { globalThis.fetch = originalFetch; },
  };
}

test("typed user sessions enforce capability boundaries and revocation", async (t) => {
  const now = Date.now();
  process.env.LEGACY_USER_SESSION_UNTIL = String(now + authSessions.USER_SESSION_TTL_MS);
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({ email: "test@example.com", balance: 25, banned: false }),
    [VERSION_KEY]: "1",
    [BALANCE_KEY]: "3750",
  });
  t.after(() => redis.restore());

  const issued = await authSessions.createUserSession("TEST@example.com", now);
  assert.equal(issued.ok, true);
  const claim = authSessions.verifyUserSessionCapability(issued.token, now);
  assert.equal(claim.typ, "user-session");
  assert.equal(claim.iss, "liumeiti-auth");
  assert.equal(claim.aud, "web-user");
  assert.equal(claim.email, "test@example.com");
  assert.equal(claim.sv, 1);

  const authenticated = await authSessions.authenticateUserRequest(requestWithToken(issued.token), { now });
  assert.equal(authenticated.ok, true);
  assert.equal(authenticated.email, "test@example.com");
  assert.equal(authenticated.legacy, false);
  assert.equal(authenticated.user.balance, 37.5);

  const afterSalesToken = authSessions.signAfterSalesToken({
    orderId: "ORDER-1",
    email: "test@example.com",
  }, undefined, now);
  assert.equal(authSessions.verifyUserSessionCapability(afterSalesToken, now), null);
  assert.equal(authSessions.verifyAfterSalesToken(afterSalesToken, now).orderId, "ORDER-1");
  const confused = await authSessions.authenticateUserRequest(requestWithToken(afterSalesToken), { now });
  assert.equal(confused.ok, false);
  assert.equal(confused.status, 401);

  const wrongAudience = utils.signSession({
    v: 2,
    typ: "user-session",
    iss: "liumeiti-auth",
    aud: "after-sales",
    sub: "test@example.com",
    email: "test@example.com",
    sv: 1,
    iat: now,
    exp: now + 60_000,
    jti: "wrong-audience-token",
  });
  assert.equal(authSessions.verifyUserSessionCapability(wrongAudience, now), null);

  const revoked = await authSessions.revokeUserSessions("test@example.com");
  assert.equal(revoked.ok, true);
  assert.equal(revoked.authVersion, 2);
  const rejectedOld = await authSessions.authenticateUserRequest(requestWithToken(issued.token), { now });
  assert.equal(rejectedOld.ok, false);
  assert.equal(rejectedOld.error, "session_revoked");

  const replacement = authSessions.signUserSessionForVersion("test@example.com", 2, now);
  const acceptedNew = await authSessions.authenticateUserRequest(requestWithToken(replacement), { now });
  assert.equal(acceptedNew.ok, true);
});

test("legacy sessions are bounded and cannot survive a revocation", async (t) => {
  const now = Date.now();
  process.env.LEGACY_USER_SESSION_UNTIL = String(now + 60_000);
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({
      email: "test@example.com",
      username: "legacy-active",
      avatarId: "avatar-01",
      inviteCode: "LEGACY01",
      coupons: [],
      referralStats: {},
      balance: 0,
      banned: false,
    }),
  });
  t.after(() => redis.restore());

  const legacy = utils.signSession({
    email: "test@example.com",
    exp: now + 120_000,
  });
  const accepted = await authSessions.authenticateUserRequest(requestWithToken(legacy), { now });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.legacy, true);
  // /api/auth/me uses this refresh token whenever auth.legacy is true. Prove
  // that an active legacy visitor can be upgraded to the typed, revocable
  // session format before the 14-day migration deadline.
  const refreshed = authSessions.refreshedUserSessionToken(accepted, now);
  const refreshedClaim = authSessions.verifyUserSessionCapability(refreshed, now);
  assert.equal(refreshedClaim.email, "test@example.com");
  assert.equal(refreshedClaim.sv, 1);
  assert.equal(refreshedClaim.typ, "user-session");

  const meResponse = await meRoute.GET(requestWithToken(legacy));
  assert.equal(meResponse.status, 200);
  const meCookie = meResponse.headers.get("set-cookie") || "";
  assert.match(meCookie, /lm_user=/);
  const meToken = decodeURIComponent(meCookie.match(/lm_user=([^;]+)/)?.[1] || "");
  assert.equal(authSessions.verifyUserSessionCapability(meToken, now)?.typ, "user-session");

  const toolMeResponse = await meRoute.GET(new Request("https://www.liumeiti.vip/api/auth/me", {
    headers: {
      cookie: `lm_user=${encodeURIComponent(legacy)}`,
      origin: "https://tool.liumeiti.vip",
    },
  }));
  assert.equal(toolMeResponse.status, 200);
  const toolMe = await toolMeResponse.json();
  assert.equal(toolMe.email, "test@example.com");
  assert.equal(toolMe.username, "legacy-active");
  assert.equal(toolMe.balance, 0);
  for (const privateField of ["orders", "coupons", "referral", "referralDownlines"]) {
    assert.equal(Object.hasOwn(toolMe, privateField), false, privateField);
  }
  const toolMeCookie = toolMeResponse.headers.get("set-cookie") || "";
  assert.equal(authSessions.verifyUserSessionCapability(
    decodeURIComponent(toolMeCookie.match(/lm_user=([^;]+)/)?.[1] || ""),
    now,
  )?.typ, "user-session");

  const legacyAfterSales = utils.signSession({
    type: "after-sales-order",
    orderId: "ORDER-LEGACY",
    email: "test@example.com",
    exp: now + 60_000,
  });
  assert.equal(authSessions.verifyAfterSalesToken(legacyAfterSales, now).orderId, "ORDER-LEGACY");
  const capabilityAsUser = await authSessions.authenticateUserRequest(requestWithToken(legacyAfterSales), { now });
  assert.equal(capabilityAsUser.ok, false);
  assert.equal(capabilityAsUser.error, "invalid_session");

  const legacyNetflix = utils.signSession({
    type: "netflix-code-session",
    orderId: "ORDER-LEGACY",
    accountHash: "account-hash",
    startedAt: now,
    exp: now + 60_000,
  });
  assert.equal(authSessions.verifyNetflixCodeSession(legacyNetflix, now).accountHash, "account-hash");
  const netflixAsUser = await authSessions.authenticateUserRequest(requestWithToken(legacyNetflix), { now });
  assert.equal(netflixAsUser.ok, false);
  assert.equal(netflixAsUser.error, "invalid_session");

  const legacyAdmin = utils.signSession({
    role: "admin",
    staffId: 1,
    email: "test@example.com",
    exp: now + 60_000,
  });
  const adminAsUser = await authSessions.authenticateUserRequest(requestWithToken(legacyAdmin), { now });
  assert.equal(adminAsUser.ok, false);
  assert.equal(adminAsUser.error, "invalid_session");

  redis.store.set(VERSION_KEY, "2");
  const revoked = await authSessions.authenticateUserRequest(requestWithToken(legacy), { now });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error, "session_revoked");

  redis.store.set(VERSION_KEY, "1");
  const expiredWindow = await authSessions.authenticateUserRequest(requestWithToken(legacy), { now: now + 61_000 });
  assert.equal(expiredWindow.ok, false);
  assert.equal(expiredWindow.status, 401);
  assert.equal(expiredWindow.error, "legacy_session_expired");
  const expiredResponse = authSessions.userAuthErrorResponse(expiredWindow);
  assert.equal(expiredResponse.status, 401);
  assert.match(expiredResponse.headers.get("set-cookie") || "", /lm_user=.*Max-Age=0/i);
  assert.deepEqual(await expiredResponse.json(), {
    ok: false,
    error: "legacy_session_expired",
    message: "登录状态已过期，请重新登录",
  });
});

test("legacy migration deadline is anchored to deployment and never starts on first visit", async (t) => {
  const now = Date.now();
  const previousUntil = process.env.LEGACY_USER_SESSION_UNTIL;
  const previousDeployedAt = process.env.LEGACY_USER_SESSION_DEPLOYED_AT;
  delete process.env.LEGACY_USER_SESSION_UNTIL;
  process.env.LEGACY_USER_SESSION_DEPLOYED_AT = new Date(now - authSessions.USER_SESSION_TTL_MS - 60_000).toISOString();
  t.after(() => {
    if (previousUntil == null) delete process.env.LEGACY_USER_SESSION_UNTIL;
    else process.env.LEGACY_USER_SESSION_UNTIL = previousUntil;
    if (previousDeployedAt == null) delete process.env.LEGACY_USER_SESSION_DEPLOYED_AT;
    else process.env.LEGACY_USER_SESSION_DEPLOYED_AT = previousDeployedAt;
  });
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({ email: "test@example.com", banned: false }),
  });
  t.after(() => redis.restore());

  const legacy = utils.signSession({ email: "test@example.com", exp: now + 120_000 });
  const deadline = authSessions.configuredLegacyUserDeadline();
  assert.ok(deadline < now, "the fixed deployment window must already be expired");
  const result = await authSessions.authenticateUserRequest(requestWithToken(legacy), { now });
  assert.equal(result.status, 401);
  assert.equal(result.error, "legacy_session_expired");
  assert.equal(redis.store.has(LEGACY_DEADLINE_KEY), false, "a visitor must not create a new rolling deadline");
});

test("legacy migration accepts an explicit absolute deadline or a pre-initialized Redis anchor only", async (t) => {
  const now = Date.now();
  const previousUntil = process.env.LEGACY_USER_SESSION_UNTIL;
  const previousDeployedAt = process.env.LEGACY_USER_SESSION_DEPLOYED_AT;
  delete process.env.LEGACY_USER_SESSION_UNTIL;
  delete process.env.LEGACY_USER_SESSION_DEPLOYED_AT;
  t.after(() => {
    if (previousUntil == null) delete process.env.LEGACY_USER_SESSION_UNTIL;
    else process.env.LEGACY_USER_SESSION_UNTIL = previousUntil;
    if (previousDeployedAt == null) delete process.env.LEGACY_USER_SESSION_DEPLOYED_AT;
    else process.env.LEGACY_USER_SESSION_DEPLOYED_AT = previousDeployedAt;
  });
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({ email: "test@example.com", banned: false }),
  });
  t.after(() => redis.restore());
  const legacy = utils.signSession({ email: "test@example.com", exp: now + 120_000 });

  const uninitialized = await authSessions.authenticateUserRequest(requestWithToken(legacy), { now });
  assert.equal(uninitialized.status, 503);
  assert.equal(uninitialized.error, "auth_store_unavailable");
  assert.equal(redis.store.has(LEGACY_DEADLINE_KEY), false);

  redis.store.set(LEGACY_DEADLINE_KEY, String(now + 30_000));
  const accepted = await authSessions.authenticateUserRequest(requestWithToken(legacy), { now });
  assert.equal(accepted.ok, true);
  const expired = await authSessions.authenticateUserRequest(requestWithToken(legacy), { now: now + 30_000 });
  assert.equal(expired.status, 401);
  assert.equal(expired.error, "legacy_session_expired");

  process.env.LEGACY_USER_SESSION_UNTIL = new Date(now + 45_000).toISOString();
  process.env.LEGACY_USER_SESSION_DEPLOYED_AT = new Date(now - authSessions.USER_SESSION_TTL_MS).toISOString();
  assert.equal(authSessions.configuredLegacyUserDeadline(), Date.parse(process.env.LEGACY_USER_SESSION_UNTIL));
});

test("banned and deleted users fail closed", async (t) => {
  const now = Date.now();
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({ email: "test@example.com", banned: true }),
    [VERSION_KEY]: "1",
  });
  t.after(() => redis.restore());

  const token = authSessions.signUserSessionForVersion("test@example.com", 1, now);
  const banned = await authSessions.authenticateUserRequest(requestWithToken(token), { now });
  assert.equal(banned.ok, false);
  assert.equal(banned.status, 403);
  assert.equal(banned.error, "account_banned");

  redis.store.delete(USER_KEY);
  const deleted = await authSessions.authenticateUserRequest(requestWithToken(token), { now });
  assert.equal(deleted.ok, false);
  assert.equal(deleted.status, 401);
  assert.equal(deleted.error, "session_revoked");
});

test("admin deletion atomically advances the tombstone and old tokens stay revoked after re-registration", async (t) => {
  const now = Date.now();
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({
      email: "test@example.com",
      username: "old-lifecycle",
      passwordHash: utils.hashPassword("old-password"),
      balance: 12,
      banned: false,
    }),
    [VERSION_KEY]: "1",
    [BALANCE_KEY]: "1200",
    [`${USER_KEY}:tx`]: [JSON.stringify({ id: "TX-OLD" })],
  });
  t.after(() => redis.restore());

  const revoked = await authSessions.revokeUserSessions("test@example.com");
  assert.equal(revoked.authVersion, 2);
  const oldLifecycle = await authSessions.createUserSession("test@example.com", now, 2);
  assert.equal(oldLifecycle.ok, true);
  assert.match(oldLifecycle.accountLifecycleId, /^[a-f0-9]{32}$/);
  const oldLifecycleId = oldLifecycle.accountLifecycleId;
  assert.equal(authSessions.verifyUserSessionCapability(oldLifecycle.token, now).sv, 2);

  const adminToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "root",
    exp: now + 60_000,
  });
  const response = await adminUserRoute.DELETE(new Request("https://www.liumeiti.vip/api/admin/users/test%40example.com", {
    method: "DELETE",
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
  }), { params: Promise.resolve({ email: "test%40example.com" }) });
  assert.equal(response.status, 200);
  assert.equal(redis.store.get(VERSION_KEY), "3");
  assert.equal(redis.store.has(USER_KEY), false);
  assert.equal(redis.store.has(BALANCE_KEY), false);
  assert.equal(redis.store.has(`${USER_KEY}:tx`), false);
  assert.equal(redis.store.has(LIFECYCLE_KEY), false);

  const whileDeleted = await authSessions.createUserSession("test@example.com", now, 3);
  assert.deepEqual(whileDeleted, { ok: false, error: "user_not_found" });

  const recreated = await utils.setUser("test@example.com", {
    email: "test@example.com",
    username: "new-lifecycle",
    passwordHash: utils.hashPassword("new-password"),
    balance: 0,
    coupons: [],
    banned: false,
  }, { createOnly: true, returnResult: true });
  assert.equal(recreated.ok, true);
  assert.equal(recreated.authVersion, 3);
  assert.match(recreated.accountLifecycleId, /^[a-f0-9]{32}$/);
  assert.notEqual(recreated.accountLifecycleId, oldLifecycleId);
  assert.equal(redis.store.get(VERSION_KEY), "3", "registration must preserve the deletion tombstone");

  const staleIssue = await authSessions.createUserSession("test@example.com", now, 2);
  assert.deepEqual(staleIssue, { ok: false, error: "session_state_changed" });
  const rejectedOld = await authSessions.authenticateUserRequest(requestWithToken(oldLifecycle.token), { now });
  assert.equal(rejectedOld.ok, false);
  assert.equal(rejectedOld.error, "session_revoked");

  const replacement = await authSessions.createUserSession("test@example.com", now, recreated.authVersion);
  assert.equal(replacement.ok, true);
  assert.equal(authSessions.verifyUserSessionCapability(replacement.token, now).sv, 3);
  assert.equal((await authSessions.authenticateUserRequest(requestWithToken(replacement.token), { now })).ok, true);
});

test("registration cannot mint a cookie for a lifecycle deleted after its profile write", async (t) => {
  const redis = installFakeRedis({ [VERSION_KEY]: "7" });
  t.after(() => redis.restore());

  const captchaAnswer = "2468";
  const request = (password) => new Request("https://www.liumeiti.vip/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@example.com",
      password,
      captchaToken: utils.signRegisterCaptcha(captchaAnswer),
      captchaAnswer,
    }),
  });

  const first = await registerRoute.POST(request("first-password"));
  assert.equal(first.status, 200);
  const firstToken = decodeURIComponent((first.headers.get("set-cookie") || "").match(/lm_user=([^;]+)/)?.[1] || "");
  assert.equal(authSessions.verifyUserSessionCapability(firstToken)?.sv, 7);

  const deleted = await utils.deleteUser("test@example.com");
  assert.equal(deleted.ok, true);
  assert.equal(deleted.authVersion, 8);
  redis.state.afterProfileSave = ({ store }) => {
    store.delete(USER_KEY);
    store.delete(BALANCE_KEY);
    store.set(VERSION_KEY, "9");
  };

  const raced = await registerRoute.POST(request("second-password"));
  assert.equal(raced.status, 409);
  assert.equal((await raced.json()).error, "user_not_found");
  assert.equal(raced.headers.get("set-cookie"), null);
  assert.equal(redis.store.get(VERSION_KEY), "9");
  assert.equal(redis.store.has(USER_KEY), false);
});

test("OAuth merge refuses to overwrite a delete/re-registration lifecycle", async (t) => {
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({
      email: "test@example.com",
      username: "oauth-old",
      inviteCode: "MYOLD123",
      passwordHash: utils.hashPassword("old-password"),
      balance: 0,
      banned: false,
    }),
    [VERSION_KEY]: "4",
  });
  t.after(() => redis.restore());
  redis.state.afterAuthStateRead = ({ store }) => {
    store.set(USER_KEY, JSON.stringify({
      email: "test@example.com",
      username: "password-registration-winner",
      inviteCode: "MYNEW456",
      passwordHash: utils.hashPassword("new-owner-password"),
      balance: 0,
      banned: false,
    }));
    store.set(VERSION_KEY, "5");
  };

  const result = await utils.ensureOAuthUser({
    email: "test@example.com",
    provider: "google",
    providerId: "google-old-flow",
    username: "Google User",
  });
  assert.deepEqual(result, { ok: false, error: "account_state_changed" });
  const winner = JSON.parse(redis.store.get(USER_KEY));
  assert.equal(winner.username, "password-registration-winner");
  assert.equal(winner.social, undefined);
  assert.equal(utils.verifyPassword("new-owner-password", winner.passwordHash), true);
  assert.equal(redis.store.get(VERSION_KEY), "5");
});

test("user lifecycle scripts explicitly fail closed in unsupported Redis Cluster mode", async () => {
  const previous = process.env.LIUMEITI_REDIS_ATOMIC_KEYSPACE;
  process.env.LIUMEITI_REDIS_ATOMIC_KEYSPACE = "cluster-v1";
  try {
    assert.deepEqual(
      await authSessions.createUserSession("test@example.com"),
      { ok: false, error: "redis_cluster_keyspace_not_supported" },
    );
    assert.deepEqual(
      await authSessions.revokeUserSessions("test@example.com"),
      { ok: false, error: "redis_cluster_keyspace_not_supported" },
    );
    assert.deepEqual(
      await utils.deleteUser("test@example.com"),
      { ok: false, error: "redis_cluster_keyspace_not_supported" },
    );
  } finally {
    if (previous === undefined) delete process.env.LIUMEITI_REDIS_ATOMIC_KEYSPACE;
    else process.env.LIUMEITI_REDIS_ATOMIC_KEYSPACE = previous;
  }
});

test("password reset and admin ban revoke the previous session version", async (t) => {
  const now = Date.now();
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({
      email: "test@example.com",
      passwordHash: utils.hashPassword("old-password"),
      banned: false,
    }),
    [VERSION_KEY]: "1",
    [RESET_KEY]: "123456",
  });
  t.after(() => redis.restore());

  const oldToken = authSessions.signUserSessionForVersion("test@example.com", 1, now);
  const resetResponse = await resetRoute.POST(new Request("https://www.liumeiti.vip/api/auth/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@example.com",
      code: "123456",
      newPassword: "new-password",
    }),
  }));
  assert.equal(resetResponse.status, 200);
  assert.equal(redis.store.get(VERSION_KEY), "2");
  assert.equal(redis.store.has(RESET_KEY), false);
  const resetUser = JSON.parse(redis.store.get(USER_KEY));
  assert.equal(utils.verifyPassword("new-password", resetUser.passwordHash), true);

  const oldAfterReset = await authSessions.authenticateUserRequest(requestWithToken(oldToken), { now });
  assert.equal(oldAfterReset.ok, false);
  assert.equal(oldAfterReset.error, "session_revoked");
  const resetCookie = resetResponse.headers.get("set-cookie") || "";
  const resetCookieMatch = resetCookie.match(/lm_user=([^;]+)/);
  assert.ok(resetCookieMatch);
  const resetToken = decodeURIComponent(resetCookieMatch[1]);
  const newAfterReset = await authSessions.authenticateUserRequest(requestWithToken(resetToken), { now });
  assert.equal(newAfterReset.ok, true);

  const adminToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "admin",
    exp: now + 60_000,
  });
  const banResponse = await adminUserRoute.PATCH(new Request("https://www.liumeiti.vip/api/admin/users/test%40example.com", {
    method: "PATCH",
    headers: {
      cookie: `lm_admin=${encodeURIComponent(adminToken)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ banned: true }),
  }), { params: Promise.resolve({ email: "test%40example.com" }) });
  assert.equal(banResponse.status, 200);
  assert.equal(redis.store.get(VERSION_KEY), "3");
  assert.equal(JSON.parse(redis.store.get(USER_KEY)).banned, true);
  const oldAfterBan = await authSessions.authenticateUserRequest(requestWithToken(resetToken), { now });
  assert.equal(oldAfterBan.ok, false);
});

test("password reset code is consumed atomically and a stale password read cannot mint the new session version", async (t) => {
  const now = Date.now();
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({
      email: "test@example.com",
      passwordHash: utils.hashPassword("old-password"),
      coupons: [],
      banned: false,
    }),
    [VERSION_KEY]: "1",
    [RESET_KEY]: "654321",
  });
  t.after(() => redis.restore());

  // This snapshot models a login that read the old password and version in
  // one MGET immediately before the reset commits.
  const staleLoginState = await authSessions.readUserAuthState("test@example.com");
  assert.equal(staleLoginState.ok, true);
  assert.equal(staleLoginState.authVersion, 1);
  assert.equal(utils.verifyPassword("old-password", staleLoginState.user.passwordHash), true);

  const resetBodies = ["new-password-a", "new-password-b"].map((newPassword) => (
    resetRoute.POST(new Request("https://www.liumeiti.vip/api/auth/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", code: "654321", newPassword }),
    }))
  ));
  const responses = await Promise.all(resetBodies);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
  assert.equal(redis.store.has(RESET_KEY), false);
  assert.equal(redis.store.get(VERSION_KEY), "2");
  const savedUser = JSON.parse(redis.store.get(USER_KEY));
  assert.equal(Array.isArray(savedUser.coupons), true);
  assert.equal([
    utils.verifyPassword("new-password-a", savedUser.passwordHash),
    utils.verifyPassword("new-password-b", savedUser.passwordHash),
  ].filter(Boolean).length, 1);

  const staleIssue = await authSessions.createUserSession(
    "test@example.com",
    now,
    staleLoginState.authVersion,
  );
  assert.deepEqual(staleIssue, { ok: false, error: "session_state_changed" });
});

test("balance referral backfill cannot write an old profile into a re-registered lifecycle", async (t) => {
  const now = Date.now();
  const oldLifecycle = "a".repeat(32);
  const replacementLifecycle = "b".repeat(32);
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({
      email: "test@example.com",
      username: "old-account",
      passwordHash: "old-password-hash",
      balance: 0,
      coupons: [],
      banned: false,
    }),
    [VERSION_KEY]: "7",
    [LIFECYCLE_KEY]: oldLifecycle,
    [BALANCE_KEY]: "0",
  });
  t.after(() => redis.restore());

  redis.state.afterAuthStateRead = ({ store }) => {
    // Keep the version deliberately equal so this regression proves the
    // lifecycle check itself prevents the stale write.
    store.set(USER_KEY, JSON.stringify({
      email: "test@example.com",
      username: "replacement-account",
      passwordHash: "replacement-password-hash",
      inviteCode: "MYREPLACEMENT",
      balance: 0,
      coupons: [],
      banned: false,
    }));
    store.set(VERSION_KEY, "7");
    store.set(LIFECYCLE_KEY, replacementLifecycle);
  };

  const token = authSessions.signUserSessionForVersion("test@example.com", 7, now);
  const response = await balanceRoute.GET(new Request("https://www.liumeiti.vip/api/auth/balance", {
    headers: { cookie: `lm_user=${encodeURIComponent(token)}` },
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "session_state_changed");
  const replacement = JSON.parse(redis.store.get(USER_KEY));
  assert.equal(replacement.username, "replacement-account");
  assert.equal(replacement.passwordHash, "replacement-password-hash");
  assert.equal(replacement.inviteCode, "MYREPLACEMENT");
  assert.equal(redis.store.get(LIFECYCLE_KEY), replacementLifecycle);
  assert.deepEqual(
    Array.from(redis.store.keys()).filter((key) => key.startsWith("liumeiti:invite-code:")),
    [],
  );
});

test("Netflix user toggle cannot overwrite or revive a re-registered account", async (t) => {
  const orderId = "LM-NETFLIX-LIFECYCLE-1";
  const orderKey = `liumeiti:orders:record:${orderId}`;
  const oldLifecycle = "c".repeat(32);
  const replacementLifecycle = "d".repeat(32);
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({
      email: "test@example.com",
      username: "old-account",
      passwordHash: "old-password-hash",
      netflixSelfServiceDisabled: false,
      balance: 0,
      coupons: [],
      banned: false,
    }),
    [VERSION_KEY]: "9",
    [LIFECYCLE_KEY]: oldLifecycle,
    [BALANCE_KEY]: "0",
    [orderKey]: JSON.stringify({
      orderId,
      email: "delivery@example.com",
      userEmail: "test@example.com",
      items: [{ service: "netflix" }],
      revision: 1,
    }),
  });
  t.after(() => redis.restore());

  redis.state.afterAuthStateRead = ({ store }) => {
    store.set(USER_KEY, JSON.stringify({
      email: "test@example.com",
      username: "replacement-account",
      passwordHash: "replacement-password-hash",
      netflixSelfServiceDisabled: false,
      balance: 0,
      coupons: [],
      banned: false,
    }));
    store.set(VERSION_KEY, "9");
    store.set(LIFECYCLE_KEY, replacementLifecycle);
  };

  const adminToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "admin",
    exp: Date.now() + 60_000,
  });
  const response = await adminNetflixRoute.PATCH(new Request("https://www.liumeiti.vip/api/admin/netflix-code", {
    method: "PATCH",
    headers: {
      cookie: `lm_admin=${encodeURIComponent(adminToken)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "toggle_user", orderId, enabled: false }),
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "account_lifecycle_changed");
  const replacement = JSON.parse(redis.store.get(USER_KEY));
  assert.equal(replacement.username, "replacement-account");
  assert.equal(replacement.passwordHash, "replacement-password-hash");
  assert.equal(replacement.netflixSelfServiceDisabled, false);
  assert.equal(redis.store.get(LIFECYCLE_KEY), replacementLifecycle);
});

test("logout clears the cookie and revokes the token on every device", async (t) => {
  const now = Date.now();
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({ email: "test@example.com", banned: false }),
    [VERSION_KEY]: "1",
  });
  t.after(() => redis.restore());

  const token = authSessions.signUserSessionForVersion("test@example.com", 1, now);
  assert.equal((await authSessions.authenticateUserRequest(requestWithToken(token), { now })).ok, true);

  const logout = await loginRoute.DELETE(new Request("https://www.liumeiti.vip/api/auth/login", {
    method: "DELETE",
    headers: { cookie: `lm_user=${encodeURIComponent(token)}` },
  }));
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).revoked, true);
  assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/);
  assert.equal(redis.store.get(VERSION_KEY), "2");

  const afterLogout = await authSessions.authenticateUserRequest(requestWithToken(token), { now });
  assert.equal(afterLogout.ok, false);
  assert.equal(afterLogout.error, "session_revoked");
});

test("logout keeps the browser session retryable when durable revocation is unavailable", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "unavailable" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const token = authSessions.signUserSessionForVersion("test@example.com", 1);
  const response = await loginRoute.DELETE(new Request("https://www.liumeiti.vip/api/auth/login", {
    method: "DELETE",
    headers: { cookie: `lm_user=${encodeURIComponent(token)}` },
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("retry-after"), "5");
});

test("real Redis keeps delete, tombstone advancement, re-registration, and issuance in one lifecycle order", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-user-delete-${process.pid}-${Date.now()}`;
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
    redis.run(["SET", USER_KEY, JSON.stringify({
      email: "test@example.com",
      username: "real-old",
      passwordHash: utils.hashPassword("real-old-password"),
      balance: 25,
      coupons: [],
      banned: false,
    })]);
    redis.run(["SET", BALANCE_KEY, "2500"]);
    redis.run(["SET", VERSION_KEY, "1"]);
    redis.run(["LPUSH", `${USER_KEY}:tx`, JSON.stringify({ id: "TX-REAL" })]);
    redis.run(["SADD", "liumeiti:users:emails", "test@example.com"]);

    await withFetch(redis.fetch, async () => {
      const revoked = await authSessions.revokeUserSessions("test@example.com");
      assert.equal(revoked.authVersion, 2);
      const oldLifecycle = await authSessions.createUserSession("test@example.com", Date.now(), 2);
      assert.equal(oldLifecycle.ok, true);
      assert.match(oldLifecycle.accountLifecycleId, /^[a-f0-9]{32}$/);
      assert.equal(redis.run(["GET", LIFECYCLE_KEY]), oldLifecycle.accountLifecycleId);

      const deleted = await utils.deleteUser("test@example.com");
      assert.equal(deleted.ok, true);
      assert.equal(deleted.authVersion, 3);
      assert.equal(redis.run(["GET", VERSION_KEY]), "3");
      assert.equal(redis.run(["GET", USER_KEY]), null);
      assert.equal(redis.run(["GET", BALANCE_KEY]), null);
      assert.equal(redis.run(["GET", LIFECYCLE_KEY]), null);
      assert.deepEqual(redis.run(["LRANGE", `${USER_KEY}:tx`, "0", "-1"]), []);
      assert.equal(redis.run(["SISMEMBER", "liumeiti:users:emails", "test@example.com"]), 0);

      const noProfileIssue = await authSessions.createUserSession("test@example.com", Date.now(), 3);
      assert.deepEqual(noProfileIssue, { ok: false, error: "user_not_found" });
      const recreated = await utils.setUser("test@example.com", {
        email: "test@example.com",
        username: "real-new",
        passwordHash: utils.hashPassword("real-new-password"),
        balance: 0,
        coupons: [],
        banned: false,
      }, { createOnly: true, returnResult: true });
      assert.equal(recreated.ok, true);
      assert.equal(recreated.authVersion, 3);
      assert.match(recreated.accountLifecycleId, /^[a-f0-9]{32}$/);
      assert.notEqual(recreated.accountLifecycleId, oldLifecycle.accountLifecycleId);
      assert.equal(redis.run(["GET", VERSION_KEY]), "3");

      const staleIssue = await authSessions.createUserSession("test@example.com", Date.now(), 2);
      assert.deepEqual(staleIssue, { ok: false, error: "session_state_changed" });
      const oldRejected = await authSessions.authenticateUserRequest(requestWithToken(oldLifecycle.token));
      assert.equal(oldRejected.ok, false);
      assert.equal(oldRejected.error, "session_revoked");
      const current = await authSessions.createUserSession("test@example.com", Date.now(), 3);
      assert.equal(current.ok, true);
      assert.equal((await authSessions.authenticateUserRequest(requestWithToken(current.token))).ok, true);
    });
  } finally {
    docker(["rm", "-f", container]);
  }
});
