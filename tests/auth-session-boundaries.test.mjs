import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

function userTokenFromResponse(response) {
  const cookie = response.headers.get("set-cookie") || "";
  return decodeURIComponent(cookie.match(/(?:^|,?\s*)lm_user=([^;]+)/)?.[1] || "");
}

function maskPasswordFieldValues(raw) {
  return String(raw || "")
    .replace(/("passwordHash"\s*:\s*)"(?:\\.|[^"\\])*"/g, '$1"<passwordHash>"')
    .replace(/("passwordResetAt"\s*:\s*)(?:null|"(?:\\.|[^"\\])*")/g, '$1"<passwordResetAt>"');
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
    beforeBanCommit: null,
    authStatePayloadOverrides: [],
    forceAuthRepairCalls: 0,
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
        if (script.includes("READ_USER_AUTH_STATE_V3")) {
          const userRaw = store.get(keys[0]);
          if (!userRaw) return { result: JSON.stringify({ ok: false, error: "session_revoked" }) };
          const versionRaw = store.get(keys[1]);
          const validVersion = typeof versionRaw === "string"
            && /^\d+$/.test(versionRaw)
            && Number.isSafeInteger(Number(versionRaw))
            && Number(versionRaw) > 0
            && Number(versionRaw) <= 9007199254740990;
          const currentVersion = validVersion ? Number(versionRaw) : 1;
          if (!validVersion) store.set(keys[1], "1");
          const balanceRaw = store.get(keys[2]);
          const validBalance = typeof balanceRaw === "string"
            && /^-?\d+$/.test(balanceRaw)
            && Number.isSafeInteger(Number(balanceRaw));
          const balanceCents = validBalance ? balanceRaw : null;
          if (balanceRaw != null && !validBalance) store.delete(keys[2]);
          const lifecycleRaw = store.get(keys[3]);
          const lifecycle = /^[a-f0-9]{32}$/.test(String(lifecycleRaw || "")) ? lifecycleRaw : args[0];
          if (!/^[a-f0-9]{32}$/.test(String(lifecycleRaw || ""))) store.set(keys[3], lifecycle);
          if (typeof state.afterAuthStateRead === "function") {
            const hook = state.afterAuthStateRead;
            state.afterAuthStateRead = null;
            hook({ store, keys, values: [userRaw, String(currentVersion), balanceCents, lifecycle] });
          }
          const payload = {
            ok: true,
            userRaw,
            authVersion: currentVersion,
            accountLifecycleId: lifecycle,
            balanceCents,
            repairedAuthVersion: !validVersion,
            repairedBalance: balanceRaw != null && !validBalance,
            repairedLifecycle: lifecycle !== lifecycleRaw,
          };
          const override = state.authStatePayloadOverrides.shift();
          return { result: JSON.stringify(override ? { ...payload, ...override } : payload) };
        }
        if (script.includes("FORCE_REPAIR_USER_AUTH_STATE_V1")) {
          state.forceAuthRepairCalls += 1;
          const userRaw = store.get(keys[0]);
          if (typeof userRaw !== "string") {
            return { result: JSON.stringify({ ok: false, error: "session_revoked" }) };
          }
          const versionRaw = store.get(keys[1]);
          const validVersion = typeof versionRaw === "string"
            && /^\d+$/.test(versionRaw)
            && Number.isSafeInteger(Number(versionRaw))
            && Number(versionRaw) > 0
            && Number(versionRaw) <= 9007199254740990;
          const authVersion = validVersion ? Number(versionRaw) : 1;
          if (!validVersion) store.set(keys[1], "1");
          const balanceRaw = store.get(keys[2]);
          const validBalance = typeof balanceRaw === "string"
            && /^-?\d+$/.test(balanceRaw)
            && Number.isSafeInteger(Number(balanceRaw));
          if (balanceRaw != null && !validBalance) store.delete(keys[2]);
          const lifecycleRaw = store.get(keys[3]);
          const accountLifecycleId = /^[a-f0-9]{32}$/.test(String(lifecycleRaw || ""))
            ? lifecycleRaw
            : args[0];
          if (!/^[a-f0-9]{32}$/.test(String(lifecycleRaw || ""))) {
            store.set(keys[3], accountLifecycleId);
          }
          return { result: JSON.stringify({
            ok: true,
            userRaw,
            authVersion,
            accountLifecycleId,
            balanceCents: validBalance ? balanceRaw : null,
          }) };
        }
        if (script.includes("READ_SESSION_ISSUANCE_STATE") || script.includes("if versionType=='none' then redis.call('SET',KEYS[2],tostring(current)) end")) {
          const user = store.has(keys[0]) ? JSON.parse(store.get(keys[0])) : null;
          if (!user) return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          if (user.banned) return { result: JSON.stringify({ ok: false, error: "account_banned" }) };
          const versionRaw = store.get(keys[1]);
          const validVersion = typeof versionRaw === "string"
            && /^\d+$/.test(versionRaw)
            && Number.isSafeInteger(Number(versionRaw))
            && Number(versionRaw) > 0
            && Number(versionRaw) <= 9007199254740990;
          const currentVersion = validVersion ? Number(versionRaw) : 1;
          if (!validVersion) store.set(keys[1], "1");
          const expectedVersion = Number(args[0] || 0);
          if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
            return { result: JSON.stringify({ ok: false, error: "auth_record_invalid" }) };
          }
          if (expectedVersion > 0 && expectedVersion !== currentVersion) {
            return { result: JSON.stringify({ ok: false, error: "session_state_changed" }) };
          }
          const lifecycleRaw = store.get(keys[3]);
          const lifecycle = /^[a-f0-9]{32}$/.test(String(lifecycleRaw || "")) ? lifecycleRaw : args[2];
          if (!/^[a-f0-9]{32}$/.test(String(lifecycleRaw || ""))) store.set(keys[3], lifecycle);
          return { result: JSON.stringify({ ok: true, authVersion: currentVersion, accountLifecycleId: lifecycle }) };
        }
        if (script.includes("redis.call('SREM',KEYS[4],ARGV[1])")) {
          if (!store.has(keys[0])) return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          const userRaw = store.get(keys[0]);
          let user;
          try { user = typeof userRaw === "string" ? JSON.parse(userRaw) : null; } catch { user = null; }
          if (!user || typeof user !== "object" || Array.isArray(user)) {
            return { result: JSON.stringify({ ok: false, error: "financial_record_invalid" }) };
          }
          const balanceRaw = store.get(keys[1]);
          if (balanceRaw != null) {
            if (typeof balanceRaw !== "string" || !/^-?\d+$/.test(balanceRaw)
              || !Number.isSafeInteger(Number(balanceRaw))) {
              return { result: JSON.stringify({ ok: false, error: "financial_record_invalid" }) };
            }
            if (Number(balanceRaw) !== 0) {
              return { result: JSON.stringify({ ok: false, error: "user_has_balance" }) };
            }
          } else {
            if (typeof user.balance !== "number" || !Number.isFinite(user.balance)) {
              return { result: JSON.stringify({ ok: false, error: "financial_record_invalid" }) };
            }
            if (user.balance !== 0) {
              return { result: JSON.stringify({ ok: false, error: "user_has_balance" }) };
            }
          }
          const transactions = store.get(keys[2]);
          if (transactions != null && !Array.isArray(transactions)) {
            return { result: JSON.stringify({ ok: false, error: "financial_record_invalid" }) };
          }
          if (Array.isArray(transactions) && transactions.length > 0) {
            return { result: JSON.stringify({ ok: false, error: "user_has_financial_history" }) };
          }
          const versionRaw = store.get(keys[4]);
          const currentVersion = typeof versionRaw === "string" && /^\d+$/.test(versionRaw)
            && Number.isSafeInteger(Number(versionRaw)) && Number(versionRaw) > 0
            && Number(versionRaw) <= 9007199254740990 ? Number(versionRaw) : 1;
          const authVersion = currentVersion + 1;
          store.set(keys[4], String(authVersion));
          store.delete(keys[0]);
          store.delete(keys[1]);
          store.delete(keys[2]);
          for (const index of [5, 6, 7, 8, 9, 11]) store.delete(keys[index]);
          return { result: JSON.stringify({
            ok: true,
            authVersion,
            quotaCleanupSkipped: false,
            user: {
              email: user.email || args[0],
              username: user.username || "",
              invitedByEmail: user.invitedByEmail || "",
              invitedBy2Email: user.invitedBy2Email || "",
              inviteCode: user.inviteCode || "",
            },
          }) };
        }
        if (script.includes("READ_PASSWORD_RESET_PROFILE_V1")) {
          if (store.get(keys[1]) !== args[0]) {
            return { result: JSON.stringify({ ok: false, error: "code_invalid_or_expired" }) };
          }
          const userRaw = store.get(keys[0]);
          if (typeof userRaw !== "string") {
            return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          }
          return { result: JSON.stringify({ ok: true, userRaw }) };
        }
        if (script.includes("RESET_PASSWORD_AND_REVOKE_V2")) {
          if (store.get(keys[2]) !== args[2]) {
            return { result: JSON.stringify({ ok: false, error: "code_invalid_or_expired" }) };
          }
          if (!store.has(keys[0])) return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          if (store.get(keys[0]) !== args[3]) {
            return { result: JSON.stringify({ ok: false, error: "account_state_changed" }) };
          }
          const versionRaw = store.get(keys[1]);
          const validVersion = typeof versionRaw === "string"
            && /^\d+$/.test(versionRaw)
            && Number.isSafeInteger(Number(versionRaw))
            && Number(versionRaw) > 0
            && Number(versionRaw) < 9007199254740990;
          const currentVersion = validVersion ? Number(versionRaw) : 1;
          store.set(keys[0], args[4]);
          store.set(keys[1], String(currentVersion + 1));
          store.delete(keys[2]);
          return { result: JSON.stringify({ ok: true, authVersion: currentVersion + 1 }) };
        }
        if (script.includes("READ_BAN_PROFILE_V1")) {
          const userRaw = store.get(keys[0]);
          if (typeof userRaw !== "string") {
            return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          }
          return { result: JSON.stringify({ ok: true, userRaw }) };
        }
        if (script.includes("SET_BAN_STATE_AND_REVOKE_V2")) {
          if (typeof state.beforeBanCommit === "function") {
            const hook = state.beforeBanCommit;
            state.beforeBanCommit = null;
            hook({ store, keys, args });
          }
          if (!store.has(keys[0])) return { result: JSON.stringify({ ok: false, error: "user_not_found" }) };
          if (store.get(keys[0]) !== args[1]) {
            return { result: JSON.stringify({ ok: false, error: "account_state_changed" }) };
          }
          const target = args[0] === "1";
          const versionRaw = store.get(keys[1]);
          const validVersion = typeof versionRaw === "string"
            && /^\d+$/.test(versionRaw)
            && Number.isSafeInteger(Number(versionRaw))
            && Number(versionRaw) > 0
            && Number(versionRaw) < 9007199254740990;
          const currentVersion = validVersion ? Number(versionRaw) : 1;
          if (!validVersion) store.set(keys[1], "1");
          if (args[3] !== "1") {
            return { result: JSON.stringify({ ok: true, changed: false, authVersion: currentVersion, banned: target }) };
          }
          store.set(keys[0], args[2]);
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
    if (op === "TYPE") return redisResponse(store.has(parts[1]) ? "string" : "none");
    if (op === "GET") return redisResponse(store.get(parts[1]) ?? null);
    if (op === "LRANGE") {
      const value = store.get(parts[1]);
      if (value == null) return redisResponse([]);
      if (!Array.isArray(value)) return redisResponse({ error: "WRONGTYPE" });
      const start = Number(parts[2]);
      const requestedStop = Number(parts[3]);
      const stop = requestedStop < 0 ? value.length + requestedStop : requestedStop;
      return redisResponse(stop < start ? [] : value.slice(start, stop + 1));
    }
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

test("legacy migration self-initializes a missing anchor without turning old sessions into a 503 loop", async (t) => {
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
  assert.equal(uninitialized.ok, true);
  assert.equal(
    redis.store.get(LEGACY_DEADLINE_KEY),
    String(now + authSessions.USER_SESSION_TTL_MS),
    "the first active legacy request must create one shared fixed deadline",
  );

  redis.store.set(LEGACY_DEADLINE_KEY, "not-a-timestamp");
  const corruptAnchor = await authSessions.authenticateUserRequest(requestWithToken(legacy), { now });
  assert.equal(corruptAnchor.status, 401);
  assert.equal(corruptAnchor.error, "legacy_session_expired");

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

test("historical malformed auth shadow keys are repaired instead of locking the account", async (t) => {
  const now = Date.now();
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({
      email: "test@example.com",
      passwordHash: utils.hashPassword("legacy-password"),
      balance: 12.5,
      banned: false,
    }),
    [VERSION_KEY]: "",
    [BALANCE_KEY]: "12.5",
  });
  t.after(() => redis.restore());

  const state = await authSessions.readUserAuthState("test@example.com");
  assert.equal(state.ok, true);
  assert.equal(state.authVersion, 1);
  assert.equal(state.user.balance, 12.5, "invalid shadow balance must fall back to the profile");
  assert.equal(redis.store.get(VERSION_KEY), "1");
  assert.equal(redis.store.has(BALANCE_KEY), false);
  assert.match(redis.store.get(LIFECYCLE_KEY), /^[a-f0-9]{32}$/);

  const response = await loginRoute.POST(new Request("https://www.liumeiti.vip/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test@example.com", password: "legacy-password" }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  const token = userTokenFromResponse(response);
  assert.ok(token);

  redis.store.delete(VERSION_KEY);
  const accountAfterMissingVersion = await meRoute.GET(requestWithToken(token));
  assert.equal(accountAfterMissingVersion.status, 200);
  assert.equal((await accountAfterMissingVersion.json()).ok, true);
  assert.equal(redis.store.get(VERSION_KEY), "1");
});

test("malformed auth-state payloads re-read and canonically repair without a 5xx", async (t) => {
  const lifecycle = "a".repeat(32);
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({
      email: "test@example.com",
      username: "legacy-payload",
      balance: 27.5,
      coupons: [],
      banned: false,
    }),
    [VERSION_KEY]: "bad-version",
    [BALANCE_KEY]: "27.50",
    [LIFECYCLE_KEY]: "BAD-LIFECYCLE",
  });
  t.after(() => redis.restore());
  const malformed = {
    authVersion: "not-a-number",
    balanceCents: "27.50",
    accountLifecycleId: "not-a-lifecycle",
  };
  redis.state.authStatePayloadOverrides.push(malformed, malformed);

  const repaired = await authSessions.readUserAuthState("test@example.com");
  assert.equal(repaired.ok, true);
  assert.equal(repaired.authVersion, 1);
  assert.equal(repaired.user.balance, 27.5);
  assert.match(repaired.accountLifecycleId, /^[a-f0-9]{32}$/);
  assert.notEqual(repaired.accountLifecycleId, lifecycle);
  assert.equal(redis.state.forceAuthRepairCalls, 1);
  assert.equal(redis.store.get(VERSION_KEY), "1");
  assert.equal(redis.store.has(BALANCE_KEY), false);
  assert.equal(redis.store.get(LIFECYCLE_KEY), repaired.accountLifecycleId);

  redis.state.authStatePayloadOverrides.push(malformed);
  const recoveredByReread = await authSessions.readUserAuthState("test@example.com");
  assert.equal(recoveredByReread.ok, true);
  assert.equal(recoveredByReread.authVersion, 1);
  assert.equal(recoveredByReread.user.balance, 27.5);
  assert.equal(redis.state.forceAuthRepairCalls, 1, "one malformed response should recover on the retry");
});

test("auth state reserves 503 for a genuinely unavailable Redis transport", async () => {
  const scriptFailure = await withFetch(
    async () => Response.json([{ error: "ERR synthetic script failure" }]),
    () => authSessions.readUserAuthState("test@example.com"),
  );
  assert.equal(scriptFailure.ok, false);
  assert.equal(scriptFailure.status, 500);
  assert.equal(scriptFailure.error, "storage_error");

  const outage = await withFetch(
    async () => new Response("unavailable", { status: 503 }),
    () => authSessions.readUserAuthState("test@example.com"),
  );
  assert.equal(outage.ok, false);
  assert.equal(outage.status, 503);
  assert.equal(outage.error, "storage_unavailable");
});

test("malformed profile JSON is reported as a data conflict, not service unavailability", async (t) => {
  const redis = installFakeRedis({
    [USER_KEY]: '{"email":"test@example.com","broken":',
    [VERSION_KEY]: "1",
    [RESET_KEY]: "778899",
  });
  t.after(() => redis.restore());

  const state = await authSessions.readUserAuthState("test@example.com");
  assert.deepEqual(state, { ok: false, status: 409, error: "account_record_invalid" });

  const login = await loginRoute.POST(new Request("https://www.liumeiti.vip/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test@example.com", password: "irrelevant" }),
  }));
  assert.equal(login.status, 409);
  assert.equal((await login.json()).error, "account_record_invalid");

  const reset = await resetRoute.POST(new Request("https://www.liumeiti.vip/api/auth/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test@example.com", code: "778899", newPassword: "new-password" }),
  }));
  assert.equal(reset.status, 409);
  assert.equal((await reset.json()).error, "account_record_invalid");
});

test("admin deletion rejects a nonzero authoritative balance with 409 and preserves every record", async (t) => {
  const userRaw = JSON.stringify({
    email: "test@example.com",
    username: "funded-user",
    passwordHash: utils.hashPassword("old-password"),
    balance: 0,
    banned: false,
  });
  const redis = installFakeRedis({
    [USER_KEY]: userRaw,
    [VERSION_KEY]: "7",
    [LIFECYCLE_KEY]: "0123456789abcdef0123456789abcdef",
    [BALANCE_KEY]: "125",
  });
  t.after(() => redis.restore());

  const adminToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "root",
    exp: Date.now() + 60_000,
  });
  const response = await adminUserRoute.DELETE(new Request("https://www.liumeiti.vip/api/admin/users/test%40example.com", {
    method: "DELETE",
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
  }), { params: Promise.resolve({ email: "test%40example.com" }) });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, error: "user_has_balance" });
  assert.equal(redis.store.get(USER_KEY), userRaw);
  assert.equal(redis.store.get(BALANCE_KEY), "125");
  assert.equal(redis.store.get(VERSION_KEY), "7");
  assert.equal(redis.store.get(LIFECYCLE_KEY), "0123456789abcdef0123456789abcdef");

  const legacyRaw = JSON.stringify({
    email: "test@example.com",
    username: "legacy-funded-user",
    balance: 12.5,
  });
  redis.store.set(USER_KEY, legacyRaw);
  redis.store.delete(BALANCE_KEY);
  const legacyResponse = await adminUserRoute.DELETE(new Request("https://www.liumeiti.vip/api/admin/users/test%40example.com", {
    method: "DELETE",
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
  }), { params: Promise.resolve({ email: "test%40example.com" }) });
  assert.equal(legacyResponse.status, 409);
  assert.deepEqual(await legacyResponse.json(), { ok: false, error: "user_has_balance" });
  assert.equal(redis.store.get(USER_KEY), legacyRaw);
  assert.equal(redis.store.has(BALANCE_KEY), false);
  assert.equal(redis.store.get(VERSION_KEY), "7");
  assert.equal(redis.store.get(LIFECYCLE_KEY), "0123456789abcdef0123456789abcdef");
});

test("admin deletion rejects any financial history with 409 and preserves every record", async (t) => {
  const userRaw = JSON.stringify({
    email: "test@example.com",
    username: "history-user",
    passwordHash: utils.hashPassword("old-password"),
    balance: 0,
    banned: false,
  });
  const transactions = [JSON.stringify({ id: "TX-OLD", amount: 0 })];
  const redis = installFakeRedis({
    [USER_KEY]: userRaw,
    [VERSION_KEY]: "4",
    [LIFECYCLE_KEY]: "fedcba9876543210fedcba9876543210",
    [BALANCE_KEY]: "0",
    [`${USER_KEY}:tx`]: transactions,
  });
  t.after(() => redis.restore());

  const adminToken = utils.signSession({
    role: "admin",
    staffId: 1,
    staffUsername: "root",
    exp: Date.now() + 60_000,
  });
  const response = await adminUserRoute.DELETE(new Request("https://www.liumeiti.vip/api/admin/users/test%40example.com", {
    method: "DELETE",
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
  }), { params: Promise.resolve({ email: "test%40example.com" }) });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, error: "user_has_financial_history" });
  assert.equal(redis.store.get(USER_KEY), userRaw);
  assert.equal(redis.store.get(BALANCE_KEY), "0");
  assert.deepEqual(redis.store.get(`${USER_KEY}:tx`), transactions);
  assert.equal(redis.store.get(VERSION_KEY), "4");
  assert.equal(redis.store.get(LIFECYCLE_KEY), "fedcba9876543210fedcba9876543210");
});

test("admin deletion rejects malformed financial records without deleting account data", async (t) => {
  const userRaw = JSON.stringify({ email: "test@example.com", username: "invalid-finance", balance: 0 });
  const redis = installFakeRedis({
    [USER_KEY]: userRaw,
    [VERSION_KEY]: "3",
    [BALANCE_KEY]: [],
  });
  t.after(() => redis.restore());

  assert.deepEqual(
    await utils.deleteUser("test@example.com"),
    { ok: false, error: "financial_record_invalid" },
  );
  assert.equal(redis.store.get(USER_KEY), userRaw);
  assert.deepEqual(redis.store.get(BALANCE_KEY), []);
  assert.equal(redis.store.get(VERSION_KEY), "3");

  redis.store.set(BALANCE_KEY, "0");
  redis.store.set(`${USER_KEY}:tx`, "not-a-list");
  assert.deepEqual(
    await utils.deleteUser("test@example.com"),
    { ok: false, error: "financial_record_invalid" },
  );
  assert.equal(redis.store.get(USER_KEY), userRaw);
  assert.equal(redis.store.get(BALANCE_KEY), "0");
  assert.equal(redis.store.get(`${USER_KEY}:tx`), "not-a-list");
  assert.equal(redis.store.get(VERSION_KEY), "3");
});

test("admin deletion atomically removes a zero-balance user without financial history and keeps old tokens revoked", async (t) => {
  const now = Date.now();
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({
      email: "test@example.com",
      username: "old-lifecycle",
      passwordHash: utils.hashPassword("old-password"),
      balance: 0,
      banned: false,
    }),
    [VERSION_KEY]: "1",
    [BALANCE_KEY]: "0",
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

test("guest Netflix verification is a short-lived order-scoped capability with no session confusion", async () => {
  const now = Date.now();
  const token = authSessions.signNetflixOrderVerification({
    email: " Guest@Example.com ",
    orderIds: ["lmnetflixguest01", "LMNETFLIXGUEST02"],
  }, undefined, now);
  const claim = authSessions.verifyNetflixOrderVerification(token, now);
  assert.equal(claim.typ, "netflix-order-verification");
  assert.equal(claim.aud, "netflix-code-authorize");
  assert.equal(claim.email, "guest@example.com");
  assert.deepEqual(claim.orderIds, ["LMNETFLIXGUEST01", "LMNETFLIXGUEST02"]);

  assert.equal(authSessions.verifyUserSessionCapability(token, now), null);
  assert.equal(authSessions.verifyAfterSalesToken(token, now), null);
  assert.equal(authSessions.verifyNetflixCodeSession(token, now), null);
  assert.equal((await authSessions.authenticateUserRequest(requestWithToken(token), { now })).status, 401);
  assert.equal(authSessions.verifyNetflixOrderVerification(token, now + 15 * 60 * 1000), null);

  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.equal(authSessions.verifyNetflixOrderVerification(tampered, now), null);
  assert.equal(authSessions.signNetflixOrderVerification({ email: "guest@example.com", orderIds: [] }, undefined, now), "");
  assert.equal(authSessions.signNetflixOrderVerification({ email: "guest@example.com", orderIds: Array.from({ length: 11 }, (_, index) => `LMNETFLIX${index}VALUE`) }, undefined, now), "");
  assert.equal(authSessions.signNetflixOrderVerification({ email: "guest@example.com", orderIds: ["LMNETFLIXGUEST01", "LMNETFLIXGUEST01"] }, undefined, now), "");
  assert.equal(authSessions.signNetflixOrderVerification({ email: "", orderIds: ["LMNETFLIXGUEST01"] }, undefined, now), "");

  const malformedCookie = new Request("https://www.liumeiti.vip/api/netflix-code", {
    headers: { cookie: `${authSessions.NETFLIX_ORDER_VERIFICATION_COOKIE}=%` },
  });
  assert.equal(authSessions.netflixOrderVerificationFromRequest(malformedCookie, now), null);

  const wrongAudience = utils.signSession({
    v: 2,
    typ: "netflix-order-verification",
    iss: "liumeiti-auth",
    aud: "after-sales",
    email: "guest@example.com",
    orderIds: ["LMNETFLIXGUEST01"],
    iat: now,
    exp: now + 60_000,
    jti: "wrong-netflix-audience",
  });
  assert.equal(authSessions.verifyNetflixOrderVerification(wrongAudience, now), null);

  const legacyPurposeToken = utils.signSession({
    type: "netflix-order-verification",
    email: "guest@example.com",
    orderIds: ["LMNETFLIXGUEST01"],
    exp: now + 60_000,
  });
  assert.equal(authSessions.verifyNetflixOrderVerification(legacyPurposeToken, now), null);

  const malformedUnrelatedCookie = new Request("https://www.liumeiti.vip/api/netflix-code", {
    headers: { cookie: "lm_user=%; locale=en" },
  });
  assert.equal(utils.getCookieFromRequest(malformedUnrelatedCookie, "lm_user"), null);
  assert.equal(utils.getCookieFromRequest(malformedUnrelatedCookie, "locale"), "en");
});

test("admin deletion repairs an invalid legacy auth version and ignores corrupt derived quota data", async (t) => {
  const quotaKey = "lm:tool:quota";
  const corruptQuota = "{not-json";
  const redis = installFakeRedis({
    [USER_KEY]: JSON.stringify({ email: "test@example.com", username: "legacy-delete", balance: 0 }),
    [VERSION_KEY]: "12.5",
    [quotaKey]: corruptQuota,
  });
  t.after(() => redis.restore());

  const deleted = await utils.deleteUser("test@example.com");
  assert.equal(deleted.ok, true);
  assert.equal(deleted.authVersion, 2);
  assert.equal(deleted.quotaCleanupSkipped, true);
  assert.equal(redis.store.get(VERSION_KEY), "2");
  assert.equal(redis.store.has(USER_KEY), false);
  assert.equal(redis.store.get(quotaKey), corruptQuota);
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

test("password reset changes only password fields and preserves every other profile byte", async (t) => {
  const resetAt = "2026-08-04T04:22:00.000Z";
  const raw = [
    "{\n",
    '  "email" : "test@example.com",\n',
    '  "passwordHash" : "old-hash",\n',
    '  "passwordResetAt" : null,\n',
    '  "coupons" : [],\n',
    '  "withdrawals" : [],\n',
    '  "emptyOtherArray" : [  ],\n',
    '  "nullable" : null,\n',
    '  "largeInteger" : 123456789012345678901234567890,\n',
    '  "nested" : { "empty" : [], "nullable" : null }\n',
    "}",
  ].join("");
  const expected = raw
    .replace('"passwordHash" : "old-hash"', '"passwordHash" : "next-hash"')
    .replace('"passwordResetAt" : null', `"passwordResetAt" : ${JSON.stringify(resetAt)}`);
  const redis = installFakeRedis({
    [USER_KEY]: raw,
    [VERSION_KEY]: "legacy-invalid-version",
    [RESET_KEY]: "112233",
  });
  t.after(() => redis.restore());

  const result = await authSessions.resetPasswordAndRevokeSessions(
    "test@example.com",
    "next-hash",
    "112233",
    resetAt,
  );
  assert.deepEqual(result, {
    ok: true,
    authVersion: 2,
    email: "test@example.com",
  });
  assert.equal(redis.store.get(USER_KEY), expected);
  assert.equal(
    maskPasswordFieldValues(redis.store.get(USER_KEY)),
    maskPasswordFieldValues(raw),
    "every byte outside passwordHash/passwordResetAt must remain unchanged",
  );
  assert.equal(redis.store.get(VERSION_KEY), "2");
  assert.equal(redis.store.has(RESET_KEY), false);
  assert.match(redis.store.get(USER_KEY), /"coupons" : \[\]/);
  assert.match(redis.store.get(USER_KEY), /"withdrawals" : \[\]/);
  assert.match(redis.store.get(USER_KEY), /"emptyOtherArray" : \[  \]/);
  assert.match(redis.store.get(USER_KEY), /123456789012345678901234567890/);

  const source = readFileSync(new URL("../app/api/_auth-session.js", import.meta.url), "utf8");
  const resetScript = source.match(/const RESET_PASSWORD_AND_REVOKE_SCRIPT = `([\s\S]*?)`;/)?.[1] || "";
  assert.doesNotMatch(resetScript, /cjson\.decode/);
  assert.doesNotMatch(resetScript, /cjson\.encode\(user\)/);
  assert.doesNotMatch(resetScript, /coupons/);
  assert.match(resetScript, /redis\.call\('SET',KEYS\[1\],ARGV\[5\]\)/);

  const withoutResetAt = '{"email":"test@example.com","passwordHash":"old","coupons":[],"nested":{"passwordHash":"keep"}}';
  redis.store.set(USER_KEY, withoutResetAt);
  redis.store.set(VERSION_KEY, "1");
  redis.store.set(RESET_KEY, "223344");
  const added = await authSessions.resetPasswordAndRevokeSessions(
    "test@example.com",
    "new",
    "223344",
    resetAt,
  );
  assert.equal(added.ok, true);
  assert.equal(
    redis.store.get(USER_KEY),
    `{"email":"test@example.com","passwordHash":"new","coupons":[],"nested":{"passwordHash":"keep"},"passwordResetAt":${JSON.stringify(resetAt)}}`,
  );

  assert.deepEqual(
    await authSessions.resetPasswordAndRevokeSessions(
      "test@example.com",
      "newer",
      "223344",
      "not-a-timestamp",
    ),
    { ok: false, error: "invalid_password_update" },
  );
  const resetRouteSource = readFileSync(new URL("../app/api/auth/reset/route.js", import.meta.url), "utf8");
  assert.match(
    resetRouteSource,
    /revoked\.error === "code_invalid_or_expired" \|\| revoked\.error === "invalid_password_update" \? 400/,
  );
});

test("modified auth Lua scripts wrap JSON encoding and never re-encode a decoded profile", () => {
  const source = readFileSync(new URL("../app/api/_auth-session.js", import.meta.url), "utf8");
  const names = [
    "READ_SESSION_ISSUANCE_STATE_SCRIPT",
    "READ_PASSWORD_RESET_PROFILE_SCRIPT",
    "RESET_PASSWORD_AND_REVOKE_SCRIPT",
    "READ_BAN_PROFILE_SCRIPT",
    "SET_BAN_STATE_AND_REVOKE_SCRIPT",
    "READ_USER_AUTH_STATE_SCRIPT",
    "FORCE_REPAIR_USER_AUTH_STATE_SCRIPT",
  ];
  for (const name of names) {
    const script = source.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"))?.[1] || "";
    assert.ok(script, `${name} must be present`);
    for (const line of script.split(/\r?\n/).filter((entry) => entry.includes("cjson.encode"))) {
      assert.match(line, /pcall\(cjson\.encode,/, `${name} has an unprotected cjson.encode: ${line}`);
    }
    for (const line of script.split(/\r?\n/).filter((entry) => entry.includes("cjson.decode"))) {
      assert.match(line, /pcall\(cjson\.decode,/, `${name} has an unprotected cjson.decode: ${line}`);
    }
    assert.doesNotMatch(script, /cjson\.encode\(user\)/, `${name} must not serialize the profile table`);
  }
});

test("ban CAS retries concurrent profile changes and preserves unrelated bytes", async (t) => {
  const changedAt = new Date("2026-08-04T05:00:00.000Z");
  const raw = [
    "{\n",
    ' "email" : "test@example.com",\n',
    ' "username" : "before-race",\n',
    ' "banned" : false,\n',
    ' "coupons" : [],\n',
    ' "emptyOtherArray" : [ ],\n',
    ' "nullable" : null,\n',
    ' "largeInteger" : 123456789012345678901234567890\n',
    "}",
  ].join("");
  const concurrentRaw = raw.replace("before-race", "concurrent-winner");
  const expected = concurrentRaw
    .replace('"banned" : false', '"banned" : true')
    .replace(
      "\n}",
      `\n,"bannedAt":${JSON.stringify(changedAt.toISOString())},"bannedByStaffId":77,"unbannedByStaffId":null}`,
    );
  const redis = installFakeRedis({
    [USER_KEY]: raw,
    [VERSION_KEY]: "1",
  });
  t.after(() => redis.restore());
  redis.state.beforeBanCommit = ({ store }) => store.set(USER_KEY, concurrentRaw);

  const result = await authSessions.setUserBanStateAndRevokeSessions(
    "test@example.com",
    true,
    { staffId: 77 },
    changedAt,
  );
  assert.deepEqual(result, {
    ok: true,
    changed: true,
    authVersion: 2,
    banned: true,
    email: "test@example.com",
  });
  assert.equal(redis.store.get(USER_KEY), expected);
  assert.equal(redis.store.get(VERSION_KEY), "2");
  assert.match(redis.store.get(USER_KEY), /"username" : "concurrent-winner"/);
  assert.match(redis.store.get(USER_KEY), /"coupons" : \[\]/);
  assert.match(redis.store.get(USER_KEY), /"emptyOtherArray" : \[ \]/);
  assert.match(redis.store.get(USER_KEY), /123456789012345678901234567890/);

  const noOp = await authSessions.setUserBanStateAndRevokeSessions(
    "test@example.com",
    true,
    { staffId: 99 },
    new Date("2026-08-04T06:00:00.000Z"),
  );
  assert.equal(noOp.ok, true);
  assert.equal(noOp.changed, false);
  assert.equal(noOp.authVersion, 2);
  assert.equal(redis.store.get(USER_KEY), expected, "idempotent ban must not rewrite the profile");
  assert.equal(redis.store.get(VERSION_KEY), "2", "idempotent ban must not revoke again");
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

test("real Redis rejects funded and historical users before deleting an empty account in lifecycle order", {
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

      const funded = await utils.deleteUser("test@example.com");
      assert.deepEqual(funded, { ok: false, error: "user_has_balance" });
      assert.notEqual(redis.run(["GET", USER_KEY]), null);
      assert.equal(redis.run(["GET", BALANCE_KEY]), "2500");
      assert.equal(redis.run(["GET", VERSION_KEY]), "2");
      assert.equal(redis.run(["GET", LIFECYCLE_KEY]), oldLifecycle.accountLifecycleId);
      assert.equal(redis.run(["LLEN", `${USER_KEY}:tx`]), 1);

      redis.run(["SET", BALANCE_KEY, "0"]);
      const historical = await utils.deleteUser("test@example.com");
      assert.deepEqual(historical, { ok: false, error: "user_has_financial_history" });
      assert.notEqual(redis.run(["GET", USER_KEY]), null);
      assert.equal(redis.run(["GET", BALANCE_KEY]), "0");
      assert.equal(redis.run(["GET", VERSION_KEY]), "2");
      assert.equal(redis.run(["GET", LIFECYCLE_KEY]), oldLifecycle.accountLifecycleId);
      assert.equal(redis.run(["LLEN", `${USER_KEY}:tx`]), 1);

      redis.run(["DEL", `${USER_KEY}:tx`]);
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

test("getUser repairs invalid balance shadows and never crosses a profile identity boundary", async () => {
  const profile = { email: "test@example.com", username: "legacy", balance: 12.5, coupons: [], withdrawals: [] };
  const redis = installFakeRedis({ [USER_KEY]: JSON.stringify(profile), [BALANCE_KEY]: "12.5" });
  try {
    const fractional = await utils.getUser("TEST@example.com");
    assert.equal(fractional.balance, 12.5);
    assert.equal(redis.store.has(BALANCE_KEY), false);
    redis.store.set(BALANCE_KEY, "9007199254740992");
    const oversized = await utils.getUser("test@example.com");
    assert.equal(oversized.balance, 12.5);
    assert.equal(redis.store.has(BALANCE_KEY), false);
    redis.store.set(USER_KEY, JSON.stringify({ username: "old-no-email", balance: 3 }));
    const missingIdentity = await utils.getUser("test@example.com");
    assert.equal(missingIdentity.email, "test@example.com");
    assert.equal(missingIdentity.balance, 3);
    redis.store.set(USER_KEY, JSON.stringify({ email: "other@example.com", balance: 999 }));
    assert.equal(await utils.getUser("test@example.com"), null);
    redis.store.set(USER_KEY, "[]");
    assert.equal(await utils.getUser("test@example.com"), null);
  } finally {
    redis.restore();
  }
});

test("real Redis repairs legacy auth keys and preserves profile bytes during password reset", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-auth-repair-${process.pid}-${Date.now()}`;
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
    const resetAt = "2026-08-04T04:22:00.000Z";
    const raw = [
      "{\n",
      ' "email":"test@example.com",\n',
      ' "passwordHash" : "old-hash",\n',
      ' "passwordResetAt" : null,\n',
      ' "balance" : 19.75,\n',
      ' "coupons" : [],\n',
      ' "withdrawals" : [],\n',
      ' "emptyOtherArray" : [],\n',
      ' "nullable" : null,\n',
      ' "largeInteger" : 123456789012345678901234567890,\n',
      ' "nested" : {"items":[],"nullable":null}\n',
      "}",
    ].join("");
    const expected = raw
      .replace('"passwordHash" : "old-hash"', '"passwordHash" : "new-hash"')
      .replace('"passwordResetAt" : null', `"passwordResetAt" : ${JSON.stringify(resetAt)}`);
    redis.run(["SET", USER_KEY, raw]);
    redis.run(["SET", VERSION_KEY, "not-an-integer"]);
    redis.run(["SET", BALANCE_KEY, "19.75"]);
    redis.run(["SET", LIFECYCLE_KEY, "INVALID-LIFECYCLE"]);

    await withFetch(redis.fetch, async () => {
      const state = await authSessions.readUserAuthState("test@example.com");
      assert.equal(state.ok, true);
      assert.equal(state.authVersion, 1);
      assert.equal(state.user.balance, 19.75);
      assert.equal(redis.run(["GET", VERSION_KEY]), "1");
      assert.equal(redis.run(["GET", BALANCE_KEY]), null);
      assert.match(redis.run(["GET", LIFECYCLE_KEY]), /^[a-f0-9]{32}$/);
      assert.equal(redis.run(["GET", USER_KEY]), raw, "repair reads must not rewrite the profile");

      redis.run(["SET", RESET_KEY, "445566"]);
      const reset = await authSessions.resetPasswordAndRevokeSessions(
        "test@example.com",
        "new-hash",
        "445566",
        resetAt,
      );
      assert.equal(reset.ok, true);
      assert.equal(reset.authVersion, 2);
      assert.equal(redis.run(["GET", USER_KEY]), expected);
      assert.equal(
        maskPasswordFieldValues(redis.run(["GET", USER_KEY])),
        maskPasswordFieldValues(raw),
        "real Redis must preserve every byte outside the two password fields",
      );
      assert.equal(redis.run(["GET", VERSION_KEY]), "2");
      assert.equal(redis.run(["GET", RESET_KEY]), null);

      // Wrong Redis data types are historical-data corruption too. The read
      // path deletes only those derived keys and recreates safe defaults.
      redis.run(["DEL", VERSION_KEY, BALANCE_KEY, LIFECYCLE_KEY]);
      redis.run(["LPUSH", VERSION_KEY, "legacy-list"]);
      redis.run(["LPUSH", BALANCE_KEY, "legacy-list"]);
      redis.run(["HSET", LIFECYCLE_KEY, "legacy", "hash"]);
      const repairedTypes = await authSessions.readUserAuthState("test@example.com");
      assert.equal(repairedTypes.ok, true);
      assert.equal(repairedTypes.authVersion, 1);
      assert.equal(repairedTypes.user.balance, 19.75);
      assert.equal(redis.run(["TYPE", VERSION_KEY]), "string");
      assert.equal(redis.run(["GET", VERSION_KEY]), "1");
      assert.equal(redis.run(["TYPE", BALANCE_KEY]), "none");
      assert.equal(redis.run(["TYPE", LIFECYCLE_KEY]), "string");
      assert.match(redis.run(["GET", LIFECYCLE_KEY]), /^[a-f0-9]{32}$/);

      let corruptReadResponses = 2;
      const corruptingFetch = async (input, init = {}) => {
        const response = await redis.fetch(input, init);
        if (corruptReadResponses <= 0 || !String(init.body || "").includes("READ_USER_AUTH_STATE_V3")) {
          return response;
        }
        corruptReadResponses -= 1;
        const rows = await response.json();
        const payload = JSON.parse(rows[0].result);
        rows[0].result = JSON.stringify({
          ...payload,
          authVersion: "legacy-bad-response",
          balanceCents: "19.75",
          accountLifecycleId: "legacy-bad-response",
        });
        return Response.json(rows);
      };
      const forcedRepair = await withFetch(
        corruptingFetch,
        () => authSessions.readUserAuthState("test@example.com"),
      );
      assert.equal(forcedRepair.ok, true);
      assert.equal(forcedRepair.authVersion, 1);
      assert.equal(forcedRepair.user.balance, 19.75);
      assert.match(forcedRepair.accountLifecycleId, /^[a-f0-9]{32}$/);
      assert.equal(corruptReadResponses, 0, "both defensive reads must be challenged before force repair");

      // Session issuance is a second gate after login/reset and must repair an
      // invalid lifecycle independently instead of re-locking the account.
      redis.run(["SET", LIFECYCLE_KEY, "bad-again"]);
      const session = await authSessions.createUserSession("test@example.com", Date.now(), 1);
      assert.equal(session.ok, true);
      assert.match(session.accountLifecycleId, /^[a-f0-9]{32}$/);
      assert.equal(redis.run(["GET", LIFECYCLE_KEY]), session.accountLifecycleId);
      assert.equal(redis.run(["GET", USER_KEY]), expected);

      const bannedAt = new Date("2026-08-04T05:30:00.000Z");
      const expectedBanned = expected.replace(
        "\n}",
        `\n,"banned":true,"bannedAt":${JSON.stringify(bannedAt.toISOString())},"bannedByStaffId":55,"unbannedByStaffId":null}`,
      );
      redis.run(["SET", VERSION_KEY, "broken-before-ban"]);
      const banned = await authSessions.setUserBanStateAndRevokeSessions(
        "test@example.com",
        true,
        { staffId: 55 },
        bannedAt,
      );
      assert.equal(banned.ok, true);
      assert.equal(banned.changed, true);
      assert.equal(banned.authVersion, 2, "invalid historical version repairs to 1 before revocation");
      assert.equal(redis.run(["GET", USER_KEY]), expectedBanned);
      assert.equal(redis.run(["GET", VERSION_KEY]), "2");
      assert.match(redis.run(["GET", USER_KEY]), /"coupons" : \[\]/);
      assert.match(redis.run(["GET", USER_KEY]), /"withdrawals" : \[\]/);
      assert.match(redis.run(["GET", USER_KEY]), /123456789012345678901234567890/);

      const noOpBan = await authSessions.setUserBanStateAndRevokeSessions(
        "test@example.com",
        true,
        { staffId: 99 },
        new Date("2026-08-04T06:30:00.000Z"),
      );
      assert.equal(noOpBan.changed, false);
      assert.equal(noOpBan.authVersion, 2);
      assert.equal(redis.run(["GET", USER_KEY]), expectedBanned);
    });
  } finally {
    docker(["rm", "-f", container]);
  }
});

test("real Redis legacy account completes login, account, reset, and new-password login routes", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-auth-route-chain-${process.pid}-${Date.now()}`;
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
    // This is deliberately a pre-migration profile: it has no username,
    // avatar, coupons/referral metadata, lifecycle, or canonical balance key.
    redis.run(["SET", USER_KEY, JSON.stringify({
      email: "test@example.com",
      passwordHash: utils.hashPassword("legacy-password"),
      balance: 12.5,
      banned: false,
    })]);
    redis.run(["SET", VERSION_KEY, ""]);
    redis.run(["SET", BALANCE_KEY, "12.5"]);
    redis.run(["DEL", LIFECYCLE_KEY]);

    await withFetch(redis.fetch, async () => {
      const login = await loginRoute.POST(new Request("https://www.liumeiti.vip/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", password: "legacy-password" }),
      }));
      assert.equal(login.status, 200);
      const loginBody = await login.json();
      assert.equal(loginBody.ok, true);
      const token = userTokenFromResponse(login);
      assert.ok(token);
      assert.equal(redis.run(["GET", VERSION_KEY]), "1");
      assert.equal(redis.run(["GET", BALANCE_KEY]), null, "decimal shadow key must be removed before profile fallback");
      assert.match(redis.run(["GET", LIFECYCLE_KEY]), /^[a-f0-9]{32}$/);

      const account = await meRoute.GET(requestWithToken(token));
      assert.equal(account.status, 200);
      const accountBody = await account.json();
      assert.equal(accountBody.ok, true);
      assert.equal(accountBody.email, "test@example.com");
      assert.equal(accountBody.balance, 12.5);
      assert.match(accountBody.accountLifecycleId, /^[a-f0-9]{32}$/);
      // /api/auth/me backfills missing legacy profile fields through the
      // canonical money writer, so the deleted decimal shadow becomes cents.
      assert.equal(redis.run(["GET", BALANCE_KEY]), "1250");

      // Missing auth-version is a separate legacy shape from an empty value.
      // The already-issued v1 cookie must remain usable and recreate v1.
      redis.run(["DEL", VERSION_KEY]);
      const accountAfterMissingVersion = await meRoute.GET(requestWithToken(token));
      assert.equal(accountAfterMissingVersion.status, 200);
      assert.equal((await accountAfterMissingVersion.json()).ok, true);
      assert.equal(redis.run(["GET", VERSION_KEY]), "1");

      redis.run(["SET", RESET_KEY, "334455"]);
      const reset = await resetRoute.POST(new Request("https://www.liumeiti.vip/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "test@example.com",
          code: "334455",
          newPassword: "new-password",
        }),
      }));
      assert.equal(reset.status, 200);
      assert.equal((await reset.json()).ok, true);
      assert.equal(redis.run(["GET", VERSION_KEY]), "2");
      assert.equal(redis.run(["GET", RESET_KEY]), null);

      const oldPassword = await loginRoute.POST(new Request("https://www.liumeiti.vip/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", password: "legacy-password" }),
      }));
      assert.equal(oldPassword.status, 401);

      const newLogin = await loginRoute.POST(new Request("https://www.liumeiti.vip/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", password: "new-password" }),
      }));
      assert.equal(newLogin.status, 200);
      const newToken = userTokenFromResponse(newLogin);
      assert.ok(newToken);
      assert.equal(authSessions.verifyUserSessionCapability(newToken)?.sv, 2);

      const accountWithNewPassword = await meRoute.GET(requestWithToken(newToken));
      assert.equal(accountWithNewPassword.status, 200);
      const newAccountBody = await accountWithNewPassword.json();
      assert.equal(newAccountBody.ok, true);
      assert.equal(newAccountBody.email, "test@example.com");
      assert.equal(newAccountBody.balance, 12.5);
    });
  } finally {
    docker(["rm", "-f", container]);
  }
});
