import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

process.env.KV_REST_API_URL = "http://credential-backfill.redis.test";
process.env.KV_REST_API_TOKEN = "credential-backfill-token";
process.env.AUTH_SECRET = "credential-backfill-auth-secret-at-least-32-characters";

const {
  backfillOrderCredentialMirrors,
  mirrorPrimaryItemCredentials,
  orderCredentialMirrorBackfillInternals,
} = await import("../app/api/_order-credential-mirror-backfill.js");

function order(orderId, overrides = {}) {
  return {
    orderId,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    items: [{ service: "spotify", account: `${orderId}@new.test`, password: "new-password", staffAccount: "", staffPassword: "" }],
    account: `${orderId}@old.test`,
    password: "old-password",
    staffAccount: "old-staff",
    staffPassword: "old-staff-password",
    ...overrides,
  };
}

function harness({ legacy = [], records = [], index = [] } = {}) {
  const state = {
    cursorRaw: null,
    legacy: legacy.map((entry) => structuredClone(entry)),
    records: new Map(records.map((entry) => [entry.orderId, structuredClone(entry)])),
    index: [...index],
    locked: false,
    pageReads: 0,
    advances: 0,
    saveCalls: 0,
    failPage: false,
    failSave: false,
    conflictOnce: new Set(),
  };
  const deps = {
    async acquireLock() {
      if (state.locked) return { acquired: false, busy: true };
      state.locked = true;
      return { acquired: true };
    },
    async renewLock() { return state.locked; },
    async releaseLock() { state.locked = false; return true; },
    async readCursor() { return orderCredentialMirrorBackfillInternals.parseCursor(state.cursorRaw); },
    async readPage(cursor, count) {
      state.pageReads += 1;
      if (state.failPage) throw new Error("order_credential_backfill_store_unavailable");
      if (cursor.phase === "legacy") {
        return state.legacy.slice(cursor.offset, cursor.offset + count).map((entry, index) => ({
          orderId: entry.orderId,
          legacyIndex: cursor.offset + index,
        }));
      }
      return state.index.slice(cursor.offset, cursor.offset + count).map((orderId) => ({ orderId, legacyIndex: null }));
    },
    async readOrder(handle) {
      const stored = state.records.get(handle.orderId)
        || (Number.isInteger(handle.legacyIndex) ? state.legacy[handle.legacyIndex] : null);
      if (!stored) throw new Error("order_credential_backfill_order_unavailable");
      return { order: structuredClone(stored), index: { ...handle } };
    },
    async saveOrder(handle, next, expectedRevision) {
      state.saveCalls += 1;
      if (state.failSave) return false;
      const current = state.records.get(handle.orderId)
        || (Number.isInteger(handle.legacyIndex) ? state.legacy[handle.legacyIndex] : null);
      if (state.conflictOnce.has(handle.orderId)) {
        state.conflictOnce.delete(handle.orderId);
        const concurrent = { ...current, concurrentNote: "preserve-me", revision: Number(current.revision || 0) + 1 };
        state.records.set(handle.orderId, concurrent);
        if (Number.isInteger(handle.legacyIndex)) state.legacy[handle.legacyIndex] = structuredClone(concurrent);
        return false;
      }
      if (Number(current?.revision ?? 0) !== expectedRevision) return false;
      const saved = { ...structuredClone(next), revision: expectedRevision + 1 };
      state.records.set(handle.orderId, saved);
      if (Number.isInteger(handle.legacyIndex)) state.legacy[handle.legacyIndex] = structuredClone(saved);
      if (!state.index.includes(handle.orderId)) state.index.push(handle.orderId);
      return true;
    },
    async advanceCursor(_token, cursor, nextCursor) {
      assert.equal(cursor.raw, state.cursorRaw, "cursor advances only from the exact page that was read");
      state.cursorRaw = JSON.stringify(nextCursor);
      state.advances += 1;
    },
  };
  return { state, deps };
}

async function finishBackfill(deps, options = {}) {
  let result;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    result = await backfillOrderCredentialMirrors({ count: 2, dependencies: deps, ...options });
    assert.equal(result.ok, true, result.error);
    if (result.done) return result;
  }
  throw new Error("backfill did not finish");
}

test("primary credentials mirror for add-on and multi-item orders without touching non-primary items", () => {
  const secondItem = { service: "netflix", account: "second@test", password: "second-password", nested: { keep: true } };
  const source = order("LMADDON1", {
    items: [
      { service: "addon", account: "primary@test", password: "primary-password", staffAccount: "staff@test", staffPassword: "staff-password" },
      secondItem,
    ],
  });
  const result = mirrorPrimaryItemCredentials(source);
  assert.equal(result.changed, true);
  assert.equal(result.order.account, "primary@test");
  assert.equal(result.order.password, "primary-password");
  assert.equal(result.order.staffAccount, "staff@test");
  assert.equal(result.order.staffPassword, "staff-password");
  assert.deepEqual(result.order.items[1], secondItem);
  assert.deepEqual(source.items[1], secondItem, "the input and non-primary item are not mutated");
});

test("legacy and indexed historical orders are repaired incrementally and completion is not rescanned", async () => {
  const legacySpotify = order("LMLEGACYSPOTIFY");
  const legacyNoItems = order("LMLEGACYEMPTY", { items: [], account: "keep", password: "keep" });
  const indexedMulti = order("LMINDEXMULTI", {
    items: [
      { service: "spotify", account: "first@new.test", password: "first-new" },
      { service: "netflix", account: "do-not-change@test", password: "do-not-change" },
    ],
  });
  const { state, deps } = harness({
    legacy: [legacySpotify, legacyNoItems],
    records: [indexedMulti],
    index: [indexedMulti.orderId],
  });
  await finishBackfill(deps);
  assert.equal(state.records.get(legacySpotify.orderId).account, legacySpotify.items[0].account);
  assert.equal(state.records.get(legacySpotify.orderId).password, legacySpotify.items[0].password);
  assert.equal(state.legacy[0].account, legacySpotify.items[0].account, "legacy list is updated alongside the standalone record");
  assert.equal(state.records.has(legacyNoItems.orderId), false, "orders without items are left unchanged");
  assert.equal(state.records.get(indexedMulti.orderId).account, "first@new.test");
  assert.equal(state.records.get(indexedMulti.orderId).items[1].password, "do-not-change");

  const pageReadsAtCompletion = state.pageReads;
  state.records.set("LMNEWCONSISTENT", order("LMNEWCONSISTENT", {
    account: "LMNEWCONSISTENT@new.test",
    password: "new-password",
    staffAccount: "",
    staffPassword: "",
  }));
  state.index.push("LMNEWCONSISTENT");
  const replay = await backfillOrderCredentialMirrors({ dependencies: deps });
  assert.deepEqual(replay, { ok: true, done: true, processed: 0, updated: 0 });
  assert.equal(state.pageReads, pageReadsAtCompletion, "completed migrations do not scan every new order again");
});

test("a CAS conflict rereads and preserves the concurrent edit before retrying", async () => {
  const target = order("LMCASRETRY");
  const { state, deps } = harness({ records: [target], index: [target.orderId] });
  state.cursorRaw = JSON.stringify({ phase: "records", offset: 0 });
  state.conflictOnce.add(target.orderId);
  const result = await backfillOrderCredentialMirrors({ dependencies: deps });
  assert.equal(result.ok, true);
  assert.equal(result.done, true);
  assert.equal(state.saveCalls, 2);
  assert.equal(state.records.get(target.orderId).concurrentNote, "preserve-me");
  assert.equal(state.records.get(target.orderId).password, target.items[0].password);
});

test("storage and repeated CAS failures fail closed without moving the cursor", async () => {
  const target = order("LMFAILCLOSED");
  const pageFailure = harness({ records: [target], index: [target.orderId] });
  pageFailure.state.cursorRaw = JSON.stringify({ phase: "records", offset: 0 });
  pageFailure.state.failPage = true;
  const unavailable = await backfillOrderCredentialMirrors({ dependencies: pageFailure.deps });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, "order_credential_backfill_store_unavailable");
  assert.equal(pageFailure.state.cursorRaw, JSON.stringify({ phase: "records", offset: 0 }));
  assert.equal(pageFailure.state.advances, 0);

  const saveFailure = harness({ records: [target], index: [target.orderId] });
  saveFailure.state.cursorRaw = JSON.stringify({ phase: "records", offset: 0 });
  saveFailure.state.failSave = true;
  const conflict = await backfillOrderCredentialMirrors({ dependencies: saveFailure.deps });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "order_credential_backfill_cas_conflict");
  assert.equal(saveFailure.state.saveCalls, 3);
  assert.equal(saveFailure.state.advances, 0);
});

test("deadline interruption never advances past an unprocessed order and a retry completes safely", async () => {
  const first = order("LMDEADLINE1");
  const second = order("LMDEADLINE2");
  const { state, deps } = harness({ records: [first, second], index: [first.orderId, second.orderId] });
  state.cursorRaw = JSON.stringify({ phase: "records", offset: 0 });
  let checks = 0;
  const partial = await backfillOrderCredentialMirrors({
    count: 2,
    dependencies: deps,
    shouldContinue: () => ++checks < 3,
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.deadlineExceeded, true);
  assert.equal(partial.processed, 1);
  assert.equal(state.cursorRaw, JSON.stringify({ phase: "records", offset: 0 }));
  assert.equal(state.records.get(first.orderId).password, first.items[0].password);
  assert.equal(state.records.get(second.orderId).password, "old-password");

  const completed = await finishBackfill(deps);
  assert.equal(completed.done, true);
  assert.equal(state.records.get(second.orderId).password, second.items[0].password);
});

test("an in-flight business transition is never bypassed and keeps the cursor on the same order", async () => {
  const target = order("LMTRANSITIONPENDING", {
    pendingTransition: { id: "transition-pending-1", kind: "admin_order_update", phase: "committed" },
  });
  const { state, deps } = harness({ records: [target], index: [target.orderId] });
  state.cursorRaw = JSON.stringify({ phase: "records", offset: 0 });
  const blocked = await backfillOrderCredentialMirrors({ dependencies: deps });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "order_credential_backfill_order_transition_pending");
  assert.equal(state.saveCalls, 0, "the migration never presents itself as the transition completer");
  assert.equal(state.records.get(target.orderId).revision, 1);
  assert.equal(state.records.get(target.orderId).password, "old-password");
  assert.equal(state.cursorRaw, JSON.stringify({ phase: "records", offset: 0 }));
  assert.equal(state.advances, 0);

  const settled = { ...state.records.get(target.orderId) };
  delete settled.pendingTransition;
  settled.revision += 1;
  state.records.set(target.orderId, settled);
  const resumed = await backfillOrderCredentialMirrors({ dependencies: deps });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.done, true);
  assert.equal(state.records.get(target.orderId).password, target.items[0].password);
  assert.equal(state.records.get(target.orderId).revision, 3);
});

test("a live migration lock skips safely without reading or advancing", async () => {
  const target = order("LMBUSY");
  const { state, deps } = harness({ records: [target], index: [target.orderId] });
  state.locked = true;
  const result = await backfillOrderCredentialMirrors({ dependencies: deps });
  assert.deepEqual(result, { ok: true, skipped: true, reason: "backfill_busy", processed: 0, updated: 0 });
  assert.equal(state.pageReads, 0);
  assert.equal(state.advances, 0);
});

test("the keeper runs the bounded credential migration with its shared deadline guard", async () => {
  const source = await readFile(new URL("../app/api/_keeper.js", import.meta.url), "utf8");
  assert.match(source, /import\("\.\/_order-credential-mirror-backfill\.js"\)/);
  assert.match(source, /backfillOrderCredentialMirrors\(\{\s*count:\s*25,\s*deadlineAt,\s*shouldContinue\s*\}\)/);
});

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
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
        return Response.json(commands.map((command) => ({ result: run(command) })));
      }
      const command = url.pathname.split("/").slice(1).filter(Boolean).map(decodeURIComponent);
      return Response.json({ result: run(command) });
    },
  };
}

test("real Redis executes cursor fencing and order CAS Lua while repairing legacy and record storage", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker-backed Lua verification" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-credential-backfill-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Redis container did not become ready");
    const redis = realRedis(container);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = redis.fetch;
    try {
      const historical = order("LMREALBACKFILL", {
        pendingTransition: { id: "transition-real-1", kind: "admin_order_update", phase: "committed" },
      });
      redis.run(["RPUSH", "liumeiti:orders", JSON.stringify(historical)]);
      const blocked = await backfillOrderCredentialMirrors({ count: 1 });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.error, "order_credential_backfill_order_transition_pending");
      assert.equal(redis.run(["GET", orderCredentialMirrorBackfillInternals.CURSOR_KEY]), null, "the cursor remains before the transitioning order");
      assert.equal(redis.run(["GET", `liumeiti:orders:record:${historical.orderId}`]), null, "no standalone record is created by bypassing the transition");
      const untouchedLegacy = JSON.parse(redis.run(["LINDEX", "liumeiti:orders", "0"]));
      assert.equal(untouchedLegacy.revision, 1);
      assert.equal(untouchedLegacy.password, "old-password");
      assert.deepEqual(untouchedLegacy.pendingTransition, historical.pendingTransition);

      const settled = { ...untouchedLegacy, revision: 2 };
      delete settled.pendingTransition;
      redis.run(["LSET", "liumeiti:orders", "0", JSON.stringify(settled)]);
      let result;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        result = await backfillOrderCredentialMirrors({ count: 1 });
        assert.equal(result.ok, true, result.error);
        if (result.done) break;
      }
      assert.equal(result?.done, true);
      const stored = JSON.parse(redis.run(["GET", `liumeiti:orders:record:${historical.orderId}`]));
      const legacy = JSON.parse(redis.run(["LINDEX", "liumeiti:orders", "0"]));
      assert.equal(stored.account, historical.items[0].account);
      assert.equal(stored.password, historical.items[0].password);
      assert.equal(stored.pendingTransition, undefined);
      assert.equal(stored.revision, 3, "only the simulated business settlement and later mirror write advance revision");
      assert.equal(legacy.account, historical.items[0].account);
      assert.equal(redis.run(["LRANGE", "liumeiti:orders:index", "0", "-1"]).filter((id) => id === historical.orderId).length, 1);
      assert.equal(redis.run(["GET", orderCredentialMirrorBackfillInternals.LOCK_KEY]), null, "the token-owned lock is released");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    docker(["rm", "-f", container]);
  }
});
