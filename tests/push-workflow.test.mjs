import test from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

process.env.KV_REST_API_URL = "http://push-redis.test";
process.env.KV_REST_API_TOKEN = "push-test-token";
process.env.AUTH_SECRET = "push-route-test-secret-at-least-32-characters";
process.env.PUSH_ENABLED = "true";
process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY = "push-encryption-test-secret-at-least-32-characters";
process.env.PUSH_ACCOUNT_HMAC_SECRET = "push-account-hmac-test-secret-at-least-32-characters";
const testVapid = createECDH("prime256v1");
testVapid.setPrivateKey(Buffer.alloc(32, 13));
process.env.WEB_PUSH_VAPID_PUBLIC_KEY = testVapid.getPublicKey().toString("base64url");
process.env.WEB_PUSH_VAPID_PRIVATE_KEY = testVapid.getPrivateKey().toString("base64url");
process.env.WEB_PUSH_VAPID_SUBJECT = "mailto:push-test@example.com";
process.env.CRON_SECRET = "push-cron-test-secret-at-least-32-characters";
delete process.env.REDIS_ATOMIC_KEYSPACE_MODE;

const strings = new Map();
const expirations = new Map();
const hashes = new Map();
const sortedSets = new Map();
const lists = new Map();
const originalFetch = globalThis.fetch;
let redisFaults = [];

function failRedisOnce(predicate, { after = false, result = null } = {}) {
  redisFaults.push({ predicate, after, result });
}

function takeRedisFault(command) {
  const index = redisFaults.findIndex((fault) => fault.predicate(command));
  return index >= 0 ? redisFaults.splice(index, 1)[0] : null;
}

function hash(key) {
  if (!hashes.has(key)) hashes.set(key, new Map());
  return hashes.get(key);
}

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
}

function list(key) {
  if (!lists.has(key)) lists.set(key, []);
  return lists.get(key);
}

function mockKeyType(key) {
  if (strings.has(key)) return "string";
  if (hashes.has(key)) return "hash";
  if (sortedSets.has(key)) return "zset";
  if (lists.has(key)) return "list";
  return "none";
}

function deleteMockKey(key) {
  strings.delete(key);
  expirations.delete(key);
  hashes.delete(key);
  sortedSets.delete(key);
  lists.delete(key);
}

function setMockString(key, value) {
  deleteMockKey(key);
  strings.set(key, String(value));
}

function validAuthVersionRaw(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 9007199254740990;
}

function validBalanceRaw(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number);
}

function expireString(key) {
  const expiresAt = expirations.get(key);
  if (expiresAt != null && Date.now() >= expiresAt) {
    expirations.delete(key);
    strings.delete(key);
  }
}

function jsonList(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function strictJsonList(value) {
  if (value == null) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("corrupt_json_list");
  return parsed;
}

function executeEval(script, keys, argv) {
  if (script.includes("local oldTarget") && script.includes("return priorRaw and 'updated' or 'created'")) {
    const [subscriptionsKey, accountSubscriptionsKey, preferencesKey] = keys;
    const [id, target, recordJson, rawLimit, preferencesJson] = argv;
    const subscriptions = hash(subscriptionsKey);
    const accounts = hash(accountSubscriptionsKey);
    const priorRaw = subscriptions.get(id) || null;
    const prior = priorRaw ? JSON.parse(priorRaw) : {};
    const oldTarget = String(prior.accountTarget || "");
    const list = strictJsonList(accounts.get(target));
    if (!list.includes(id) && list.length >= Number(rawLimit)) return "limit";
    if (oldTarget && oldTarget !== target) {
      const oldList = strictJsonList(accounts.get(oldTarget)).filter((value) => value !== id);
      if (oldList.length) accounts.set(oldTarget, JSON.stringify(oldList));
      else accounts.delete(oldTarget);
    }
    if (!list.includes(id)) list.push(id);
    subscriptions.set(id, recordJson);
    accounts.set(target, JSON.stringify(list));
    hash(preferencesKey).set(target, preferencesJson);
    return priorRaw ? "updated" : "created";
  }

  if (script.includes("return 'queued'") && script.includes("requestHash")) {
    const [eventsKey, outboxKey] = keys;
    const [eventId, requestHash, eventJson, score] = argv;
    const events = hash(eventsKey);
    const priorRaw = events.get(eventId);
    if (priorRaw) {
      const prior = JSON.parse(priorRaw);
      if (prior.requestHash !== requestHash) return "conflict";
      sortedSet(outboxKey).set(eventId, Number(score));
      return "exists";
    }
    events.set(eventId, eventJson);
    sortedSet(outboxKey).set(eventId, Number(score));
    return "queued";
  }

  if (script.includes("return prior and 'updated' or 'saved'") && script.includes("requestHash")) {
    const [recoveryHashKey, recoveryIndexKey] = keys;
    const [recoveryId, requestHash, recoveryJson, score] = argv;
    const recoveries = hash(recoveryHashKey);
    const priorRaw = recoveries.get(recoveryId);
    if (priorRaw) {
      const prior = JSON.parse(priorRaw);
      if (prior.requestHash && prior.requestHash !== requestHash) return "conflict";
    }
    recoveries.set(recoveryId, recoveryJson);
    sortedSet(recoveryIndexKey).set(recoveryId, Number(score));
    return priorRaw ? "updated" : "saved";
  }

  if (script.includes("redis.call('HDEL',KEYS[1],ARGV[1])") && script.includes("redis.call('ZREM',KEYS[2],ARGV[1])") && script.includes("return 1")) {
    hash(keys[0]).delete(argv[0]);
    sortedSet(keys[1]).delete(argv[0]);
    return 1;
  }

  if (script.includes("local restocked=") && script.includes("before=before or -1")) {
    const [stockKey, eventsKey, outboxKey] = keys;
    const [rawAfter, eventId, requestHash, eventJson, score] = argv;
    const events = hash(eventsKey);
    const priorRaw = eventId ? events.get(eventId) : null;
    if (priorRaw && JSON.parse(priorRaw).requestHash !== requestHash) return "push_event_conflict";
    const beforeRaw = strings.get(stockKey);
    const before = beforeRaw == null ? null : Number(beforeRaw);
    const after = rawAfter === "unlimited" ? null : Number(rawAfter);
    if (after == null) strings.delete(stockKey);
    else strings.set(stockKey, String(after));
    const restocked = before === 0 && (after == null || after > 0);
    let queued = false;
    if (restocked && eventId) {
      if (!events.has(eventId)) {
        events.set(eventId, eventJson);
        queued = true;
      }
      sortedSet(outboxKey).set(eventId, Number(score));
    }
    return JSON.stringify({ ok: true, before: before ?? -1, after: after ?? -1, restocked, queued });
  }

  if (script.includes("READ_USER_AUTH_STATE_V3") || script.includes("FORCE_REPAIR_USER_AUTH_STATE_V1")) {
    const [userKey, authVersionKey, balanceKey, lifecycleKey] = keys;
    const userRaw = mockKeyType(userKey) === "string" ? strings.get(userKey) : null;
    if (!userRaw) return JSON.stringify({ ok: false, error: "session_revoked" });

    const versionRaw = mockKeyType(authVersionKey) === "string" ? strings.get(authVersionKey) : null;
    const repairedAuthVersion = !validAuthVersionRaw(versionRaw);
    const authVersion = repairedAuthVersion ? 1 : Number(versionRaw);
    if (repairedAuthVersion) setMockString(authVersionKey, "1");

    const balanceRaw = mockKeyType(balanceKey) === "string" ? strings.get(balanceKey) : null;
    const repairedBalance = mockKeyType(balanceKey) !== "none" && !validBalanceRaw(balanceRaw);
    const balanceCents = validBalanceRaw(balanceRaw) ? balanceRaw : null;
    if (repairedBalance) deleteMockKey(balanceKey);

    const lifecycleRaw = mockKeyType(lifecycleKey) === "string" ? strings.get(lifecycleKey) : null;
    const repairedLifecycle = !/^[a-f0-9]{32}$/.test(String(lifecycleRaw || ""));
    const lifecycle = repairedLifecycle ? argv[0] : lifecycleRaw;
    if (!/^[a-f0-9]{32}$/.test(String(lifecycle || ""))) {
      return JSON.stringify({ ok: false, error: "invalid_lifecycle_candidate" });
    }
    if (repairedLifecycle) setMockString(lifecycleKey, lifecycle);
    return JSON.stringify({
      ok: true,
      userRaw,
      authVersion,
      accountLifecycleId: lifecycle,
      balanceCents,
      repairedAuthVersion,
      repairedBalance,
      repairedLifecycle,
    });
  }

  if (script.includes("if ARGV[2]~='' and target~=ARGV[2] then return -1 end")) {
    const [subscriptionsKey, accountSubscriptionsKey] = keys;
    const [id, expectedTarget] = argv;
    const subscriptions = hash(subscriptionsKey);
    const raw = subscriptions.get(id);
    if (!raw) {
      if (!expectedTarget) return 0;
      const accounts = hash(accountSubscriptionsKey);
      const list = strictJsonList(accounts.get(expectedTarget)).filter((value) => value !== id);
      if (list.length) accounts.set(expectedTarget, JSON.stringify(list));
      else accounts.delete(expectedTarget);
      return 0;
    }
    const record = JSON.parse(raw);
    if (expectedTarget && record.accountTarget !== expectedTarget) return -1;
    subscriptions.delete(id);
    const accounts = hash(accountSubscriptionsKey);
    const list = strictJsonList(accounts.get(record.accountTarget)).filter((value) => value !== id);
    if (list.length) accounts.set(record.accountTarget, JSON.stringify(list));
    else accounts.delete(record.accountTarget);
    return 1;
  }

  if (script.includes("redis.call('HDEL',KEYS[1],tostring(id))") && script.includes("return #list")) {
    const [subscriptionsKey, accountSubscriptionsKey] = keys;
    const target = argv[0];
    const accounts = hash(accountSubscriptionsKey);
    const raw = accounts.get(target);
    if (raw == null) return 0;
    const list = strictJsonList(raw);
    for (const id of list) {
      const recordRaw = hash(subscriptionsKey).get(id);
      if (recordRaw && JSON.parse(recordRaw).accountTarget !== target) return -2;
    }
    list.forEach((id) => hash(subscriptionsKey).delete(id));
    accounts.delete(target);
    return list.length;
  }

  if (script.includes("redis.call('GET',KEYS[1])==ARGV[1]") && script.includes("redis.call('DEL',KEYS[1])")) {
    expireString(keys[0]);
    if (strings.get(keys[0]) !== argv[0]) return 0;
    strings.delete(keys[0]);
    expirations.delete(keys[0]);
    return 1;
  }

  if (script.includes("return redis.call('EXPIRE',KEYS[1],ARGV[2])")) {
    expireString(keys[0]);
    if (strings.get(keys[0]) !== argv[0]) return 0;
    expirations.set(keys[0], Date.now() + Number(argv[1]) * 1000);
    return 1;
  }

  if (script.includes("SAVE_SUCCESSFUL_DELIVERY") || (script.includes("redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])") && script.includes("redis.call('HSET',KEYS[2],ARGV[3],ARGV[4])"))) {
    hash(keys[0]).set(argv[0], argv[1]);
    hash(keys[1]).set(argv[2], argv[3]);
    return 1;
  }

  if (script.includes("return 'rescheduled'") && script.includes("current.requestHash")) {
    const current = JSON.parse(hash(keys[0]).get(argv[0]) || "null");
    if (!current) return "missing";
    if (current.requestHash !== argv[1]) return "conflict";
    hash(keys[0]).set(argv[0], argv[2]);
    sortedSet(keys[1]).set(argv[0], Number(argv[3]));
    return "rescheduled";
  }

  if (script.includes("current.deliveryFields=merged") && script.includes("return 'saved'")) {
    const current = JSON.parse(hash(keys[0]).get(argv[0]) || "null");
    if (!current) return "missing";
    if (current.requestHash !== argv[1]) return "conflict";
    current.deliveryFields = [...new Set([...(current.deliveryFields || []), ...JSON.parse(argv[2])])];
    hash(keys[0]).set(argv[0], JSON.stringify(current));
    return "saved";
  }

  if (script.includes("local deliveryCount=") && script.includes("return 'finalized'")) {
    const [eventsKey, outboxKey, deliveriesKey, stockWatchesKey, accountWatchesKey] = keys;
    const [eventId, requestHash, clearStock, rawDeliveryCount, ...rest] = argv;
    const currentRaw = hash(eventsKey).get(eventId);
    if (currentRaw && JSON.parse(currentRaw).requestHash !== requestHash) return "conflict";
    hash(eventsKey).delete(eventId);
    sortedSet(outboxKey).delete(eventId);
    const deliveryCount = Number(rawDeliveryCount);
    rest.slice(0, deliveryCount).forEach((field) => hash(deliveriesKey).delete(field));
    const productKey = rest[deliveryCount] || "";
    if (clearStock === "1" && productKey) {
      const targets = jsonList(hash(stockWatchesKey).get(productKey));
      for (const target of targets) {
        const products = jsonList(hash(accountWatchesKey).get(target)).filter((product) => product !== productKey);
        if (products.length) hash(accountWatchesKey).set(target, JSON.stringify(products));
        else hash(accountWatchesKey).delete(target);
      }
      hash(stockWatchesKey).delete(productKey);
    }
    return "finalized";
  }

  if (script.includes("redis.call('ZADD',KEYS[2],ARGV[3],ARGV[1])")) {
    hash(keys[0]).set(argv[0], argv[1]);
    sortedSet(keys[1]).set(argv[0], Number(argv[2]));
    return 1;
  }

  if (script.includes("local ids=redis.call('ZRANGEBYSCORE'") && script.includes("return #ids")) {
    const cutoff = Number(argv[0]);
    const limit = Number(argv[1]);
    const ids = [...sortedSet(keys[1])]
      .filter(([, score]) => score <= cutoff)
      .sort((left, right) => left[1] - right[1])
      .slice(0, limit)
      .map(([id]) => id);
    ids.forEach((id) => {
      hash(keys[0]).delete(id);
      sortedSet(keys[1]).delete(id);
    });
    return ids.length;
  }

  if (script.includes("local existing=redis.call('HGET',KEYS[2],ARGV[1])") && script.includes("duplicate=false")) {
    const existing = hash(keys[1]).get(argv[0]);
    if (existing) return JSON.stringify({ ok: true, duplicate: true, event: existing });
    hash(keys[1]).set(argv[0], argv[1]);
    list(keys[0]).unshift(argv[1]);
    list(keys[0]).splice(Number(argv[2]));
    strings.set(keys[2], argv[4]);
    return JSON.stringify({ ok: true, duplicate: false, event: argv[1] });
  }

  throw new Error(`unexpected EVAL: ${script.slice(0, 80)}`);
}

function execute(command) {
  const [rawName, ...args] = command.map(String);
  const name = rawName.toUpperCase();
  if (name === "GET") { expireString(args[0]); return strings.get(args[0]) ?? null; }
  if (name === "MGET") return args.map((key) => { expireString(key); return strings.get(key) ?? null; });
  if (name === "SET") {
    const [key, value, ...options] = args;
    expireString(key);
    if (options.includes("NX") && strings.has(key)) return null;
    strings.set(key, value);
    const exIndex = options.indexOf("EX");
    if (exIndex >= 0) expirations.set(key, Date.now() + Number(options[exIndex + 1]) * 1000);
    else expirations.delete(key);
    return "OK";
  }
  if (name === "DEL") {
    let removed = 0;
    for (const key of args) {
      if (strings.delete(key)) removed += 1;
      expirations.delete(key);
      if (hashes.delete(key)) removed += 1;
      if (sortedSets.delete(key)) removed += 1;
    }
    return removed;
  }
  if (name === "HGET") return hash(args[0]).get(args[1]) ?? null;
  if (name === "HMGET") return args.slice(1).map((field) => hash(args[0]).get(field) ?? null);
  if (name === "HSET") {
    const target = hash(args[0]);
    let created = 0;
    for (let index = 1; index + 1 < args.length; index += 2) {
      if (!target.has(args[index])) created += 1;
      target.set(args[index], args[index + 1]);
    }
    return created;
  }
  if (name === "HDEL") {
    let removed = 0;
    const target = hash(args[0]);
    args.slice(1).forEach((field) => { if (target.delete(field)) removed += 1; });
    return removed;
  }
  if (name === "HLEN") return hash(args[0]).size;
  if (name === "HSCAN") {
    const entries = [...hash(args[0])];
    if (args[1] === "0" && entries.length > 1) return ["17", entries.slice(0, 1).flat()];
    return ["0", entries.flat()];
  }
  if (name === "LPUSH") {
    const target = list(args[0]);
    target.unshift(...args.slice(1));
    return target.length;
  }
  if (name === "LTRIM") {
    const target = list(args[0]);
    const start = Math.max(0, Number(args[1]));
    const end = Number(args[2]);
    const kept = target.slice(start, end < 0 ? undefined : end + 1);
    target.splice(0, target.length, ...kept);
    return "OK";
  }
  if (name === "EXPIRE") return strings.has(args[0]) || lists.has(args[0]) ? 1 : 0;
  if (name === "LRANGE") {
    const target = list(args[0]);
    const end = Number(args[2]);
    return target.slice(Number(args[1]), end < 0 ? undefined : end + 1);
  }
  if (name === "ZADD") {
    const target = sortedSet(args[0]);
    const existed = target.has(args[2]);
    target.set(args[2], Number(args[1]));
    return existed ? 0 : 1;
  }
  if (name === "ZREM") {
    let removed = 0;
    const target = sortedSet(args[0]);
    args.slice(1).forEach((member) => { if (target.delete(member)) removed += 1; });
    return removed;
  }
  if (name === "ZCARD") return sortedSet(args[0]).size;
  if (name === "ZCOUNT") {
    const min = args[1] === "-inf" ? -Infinity : Number(args[1]);
    const max = args[2] === "+inf" ? Infinity : Number(args[2]);
    return [...sortedSet(args[0]).values()].filter((score) => score >= min && score <= max).length;
  }
  if (name === "ZRANGEBYSCORE") {
    const min = args[1] === "-inf" ? -Infinity : Number(args[1]);
    const max = args[2] === "+inf" ? Infinity : Number(args[2]);
    const rows = [...sortedSet(args[0])]
      .filter(([, score]) => score >= min && score <= max)
      .sort((left, right) => left[1] - right[1]);
    const limitIndex = args.indexOf("LIMIT");
    if (limitIndex >= 0) return rows.slice(Number(args[limitIndex + 1]), Number(args[limitIndex + 1]) + Number(args[limitIndex + 2])).map(([id]) => id);
    return rows.map(([id]) => id);
  }
  if (name === "EVAL") {
    const keyCount = Number(args[1]);
    return executeEval(args[0], args.slice(2, 2 + keyCount), args.slice(2 + keyCount));
  }
  throw new Error(`unexpected Redis command: ${name}`);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  try {
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(init.body || "[]");
      return new Response(JSON.stringify(commands.map((command) => ({ result: execute(command) }))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const command = url.pathname.split("/").slice(1).filter(Boolean).map(decodeURIComponent);
    const fault = takeRedisFault(command);
    const result = fault?.after ? (execute(command), fault.result) : fault ? fault.result : execute(command);
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

const redisFetch = globalThis.fetch;
const push = await import("../app/api/_push.js");
const pushClient = await import("../app/lib/push-client.js");
const authSessions = await import("../app/api/_auth-session.js");
const pushSubscriptionsRoute = await import("../app/api/auth/push/subscriptions/route.js");
const pushCronRoute = await import("../app/api/cron/push/route.js");

const auth = {
  email: "push-user@example.com",
  authVersion: 7,
  accountLifecycleId: "0123456789abcdef0123456789abcdef",
};
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/push-test-endpoint",
  expirationTime: null,
  keys: {
    p256dh: Buffer.alloc(65, 7).toString("base64url"),
    auth: Buffer.alloc(16, 9).toString("base64url"),
  },
};

function seedAuthState() {
  strings.set(`liumeiti:users:${auth.email}`, JSON.stringify({ email: auth.email, banned: false }));
  strings.set(`lm:user:authver:${auth.email}`, String(auth.authVersion));
  strings.set(`lm:user:lifecycle:${auth.email}`, auth.accountLifecycleId);
}

test.beforeEach(() => {
  strings.clear();
  expirations.clear();
  hashes.clear();
  sortedSets.clear();
  lists.clear();
  redisFaults = [];
  seedAuthState();
});

test.after(() => { globalThis.fetch = originalFetch; });

test("push Redis double mirrors V3 auth repair for wrong types and malformed strings", () => {
  const keys = [
    "liumeiti:users:push-adversarial@example.com",
    "lm:user:authver:push-adversarial@example.com",
    "liumeiti:users:push-adversarial@example.com:balance:cents",
    "lm:user:lifecycle:push-adversarial@example.com",
  ];
  const lifecycle = "abcdef0123456789abcdef0123456789";
  strings.set(keys[0], JSON.stringify({ email: "push-adversarial@example.com", balance: 12.5 }));
  hash(keys[1]).set("wrong", "type");
  list(keys[2]).push("12.5");
  sortedSet(keys[3]).set("wrong", 1);

  const repairedTypes = JSON.parse(executeEval("-- READ_USER_AUTH_STATE_V3", keys, [lifecycle]));
  assert.equal(repairedTypes.ok, true);
  assert.equal(repairedTypes.authVersion, 1);
  assert.equal(repairedTypes.balanceCents, null);
  assert.equal(repairedTypes.accountLifecycleId, lifecycle);
  assert.equal(strings.get(keys[1]), "1");
  assert.equal(mockKeyType(keys[2]), "none");
  assert.equal(strings.get(keys[3]), lifecycle);

  strings.set(keys[1], "");
  strings.set(keys[2], "12.5");
  strings.set(keys[3], "UPPERCASE-INVALID-LIFECYCLE");
  const forced = JSON.parse(executeEval("-- FORCE_REPAIR_USER_AUTH_STATE_V1", keys, [lifecycle]));
  assert.equal(forced.ok, true);
  assert.equal(forced.authVersion, 1);
  assert.equal(forced.balanceCents, null);
  assert.equal(forced.accountLifecycleId, lifecycle);
  assert.equal(mockKeyType(keys[2]), "none");
});

test("subscription validation, preferences and account target are strict", () => {
  assert.deepEqual(push.normalizePushPreferences({ orders: false, locale: "en" }), {
    enabled: true,
    orders: false,
    afterSales: true,
    renewals: true,
    stock: true,
    locale: "en",
  });
  assert.ok(push.normalizePushSubscription(subscription));
  assert.equal(push.normalizePushSubscription({ ...subscription, endpoint: "https://evil.example/push" }), null);
  assert.equal(push.normalizePushSubscription({ ...subscription, endpoint: "https://fcm.googleapis.com:8443/push" }), null);
  assert.equal(push.normalizePushSubscription({ ...subscription, keys: { ...subscription.keys, auth: "bad" } }), null);
  assert.match(push.pushAccountTarget(auth.email, auth.accountLifecycleId), /^[a-f0-9]{64}$/);
  assert.notEqual(
    push.pushAccountTarget(auth.email, auth.accountLifecycleId),
    push.pushAccountTarget(auth.email, "fedcba9876543210fedcba9876543210"),
  );
});

test("configured Push endpoint hosts extend rather than replace browser-provider defaults", () => {
  const prior = process.env.WEB_PUSH_ALLOWED_HOSTS;
  process.env.WEB_PUSH_ALLOWED_HOSTS = "push.private-gateway.example, fcm.googleapis.com";
  try {
    assert.ok(push.normalizePushSubscription({
      ...subscription,
      endpoint: "https://push.private-gateway.example/send/custom-endpoint",
    }));
    assert.ok(push.normalizePushSubscription(subscription), "the built-in FCM host remains accepted");
    assert.equal(push.normalizePushSubscription({ ...subscription, endpoint: "https://evil.example/send/nope" }), null);
  } finally {
    if (prior == null) delete process.env.WEB_PUSH_ALLOWED_HOSTS;
    else process.env.WEB_PUSH_ALLOWED_HOSTS = prior;
  }
});

test("Push configuration rejects malformed VAPID material and subjects", () => {
  const original = {
    publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY,
    privateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY,
    subject: process.env.WEB_PUSH_VAPID_SUBJECT,
  };
  try {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = "not-a-vapid-key";
    assert.equal(push.pushServerConfiguration().configured, false);
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = original.publicKey;
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "too-short";
    assert.equal(push.pushServerConfiguration().configured, false);
    const mismatched = createECDH("prime256v1");
    mismatched.setPrivateKey(Buffer.alloc(32, 23));
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = mismatched.getPrivateKey().toString("base64url");
    assert.equal(push.pushServerConfiguration().configured, false);
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = original.privateKey;
    process.env.WEB_PUSH_VAPID_SUBJECT = "javascript:alert(1)";
    assert.equal(push.pushServerConfiguration().configured, false);
  } finally {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = original.publicKey;
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = original.privateKey;
    process.env.WEB_PUSH_VAPID_SUBJECT = original.subject;
  }
  assert.equal(push.pushServerConfiguration().configured, true);
});

test("Push mutations require JSON and reject explicit cross-origin requests", async () => {
  const token = authSessions.signUserSessionForVersion(auth.email, auth.authVersion);
  const url = "https://www.liumeiti.vip/api/auth/push/subscriptions";
  const crossOrigin = await pushSubscriptionsRoute.POST(new Request(url, {
    method: "POST",
    headers: {
      cookie: `lm_user=${encodeURIComponent(token)}`,
      "content-type": "application/json",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({ subscription }),
  }));
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error, "cross_origin_request");

  const wrongType = await pushSubscriptionsRoute.POST(new Request(url, {
    method: "POST",
    headers: { cookie: `lm_user=${encodeURIComponent(token)}`, "content-type": "text/plain" },
    body: JSON.stringify({ subscription }),
  }));
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).error, "json_content_type_required");

  const sameOrigin = await pushSubscriptionsRoute.POST(new Request(url, {
    method: "POST",
    headers: {
      cookie: `lm_user=${encodeURIComponent(token)}`,
      "content-type": "application/json; charset=utf-8",
      origin: "https://www.liumeiti.vip",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ subscription }),
  }));
  assert.equal(sameOrigin.status, 200);
  assert.equal((await sameOrigin.json()).ok, true);
});

test("concurrent binds keep one encrypted subscription without endpoint or email at rest", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => push.bindPushSubscription(auth, subscription, { locale: "zh" })));
  assert.ok(results.every((result) => result.ok));
  const subscriptions = hashes.get(push.pushInternals.SUBSCRIPTIONS_HASH);
  assert.equal(subscriptions.size, 1);
  const raw = [...subscriptions.values()][0];
  assert.doesNotMatch(raw, /push-test-endpoint/);
  assert.doesNotMatch(raw, /push-user@example\.com/);
  const record = JSON.parse(raw);
  assert.equal(record.authVersion, 7);
  assert.equal(record.accountLifecycleId, auth.accountLifecycleId);
  assert.match(record.encryptedSubscription, /^v1\./);
  assert.equal((await push.getPushAccountState(auth)).subscriptionIds.length, 1);
});

test("corrupt subscription indexes and records fail closed instead of being overwritten or shown as empty", async () => {
  const first = await push.bindPushSubscription(auth, subscription);
  assert.equal(first.ok, true);
  const target = push.pushAccountTarget(auth.email, auth.accountLifecycleId);
  const id = push.pushSubscriptionId(subscription.endpoint);
  const originalRecord = hash(push.pushInternals.SUBSCRIPTIONS_HASH).get(id);

  hash(push.pushInternals.ACCOUNT_SUBSCRIPTIONS_HASH).set(target, "{broken-json");
  const stateWithCorruptIndex = await push.getPushAccountState(auth);
  assert.equal(stateWithCorruptIndex.ok, false);
  assert.equal(stateWithCorruptIndex.error, "storage_unavailable");
  const rebound = await push.bindPushSubscription(auth, subscription);
  assert.equal(rebound.ok, false);
  assert.equal(rebound.error, "storage_unavailable");
  assert.equal(hash(push.pushInternals.SUBSCRIPTIONS_HASH).get(id), originalRecord);
  assert.equal(hash(push.pushInternals.ACCOUNT_SUBSCRIPTIONS_HASH).get(target), "{broken-json");

  hash(push.pushInternals.ACCOUNT_SUBSCRIPTIONS_HASH).set(target, JSON.stringify([id]));
  hash(push.pushInternals.SUBSCRIPTIONS_HASH).set(id, "{broken-record");
  const stateWithCorruptRecord = await push.getPushAccountState(auth);
  assert.equal(stateWithCorruptRecord.ok, false);
  assert.equal(stateWithCorruptRecord.error, "storage_unavailable");

  hash(push.pushInternals.SUBSCRIPTIONS_HASH).set(id, originalRecord);
  hash(push.pushInternals.ACCOUNT_SUBSCRIPTIONS_HASH).set(
    target,
    JSON.stringify(Array.from({ length: 13 }, (_, index) => `fake-subscription-${index}`)),
  );
  const stateWithOverflow = await push.getPushAccountState(auth);
  assert.equal(stateWithOverflow.ok, false);
  assert.equal(stateWithOverflow.error, "storage_unavailable");
});

test("dispatcher rejects a sealed endpoint stored under the wrong subscription id", async () => {
  const first = await push.bindPushSubscription(auth, subscription);
  const secondSubscription = {
    ...subscription,
    endpoint: "https://fcm.googleapis.com/fcm/send/push-integrity-second",
  };
  const second = await push.bindPushSubscription(auth, secondSubscription);
  assert.equal(first.ok && second.ok, true);
  const records = hash(push.pushInternals.SUBSCRIPTIONS_HASH);
  const firstRecord = JSON.parse(records.get(first.subscriptionId));
  const secondRecord = JSON.parse(records.get(second.subscriptionId));
  records.set(second.subscriptionId, JSON.stringify({
    ...secondRecord,
    encryptedSubscription: firstRecord.encryptedSubscription,
  }));
  await push.enqueueOrderPushEvent({
    orderId: "LM-PUSH-SEALED-INTEGRITY",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
  }, "order.completed", "sealed-integrity");
  let sends = 0;
  const result = await push.dispatchPushOutbox({ sendNotification: async () => { sends += 1; } });
  assert.equal(result.ok, true);
  assert.equal(sends, 1, "the endpoint copied under a second id is never sent twice");
  assert.equal(records.has(second.subscriptionId), false);
});

test("disable-all refuses a corrupt account index that points at another account's endpoint", async () => {
  const ownerA = await push.bindPushSubscription(auth, subscription);
  const otherAuth = {
    email: "other-push-user@example.com",
    authVersion: 3,
    accountLifecycleId: "fedcba9876543210fedcba9876543210",
  };
  const otherSubscription = {
    ...subscription,
    endpoint: "https://fcm.googleapis.com/fcm/send/other-account-endpoint",
  };
  const ownerB = await push.bindPushSubscription(otherAuth, otherSubscription);
  const targetA = push.pushAccountTarget(auth.email, auth.accountLifecycleId);
  hash(push.pushInternals.ACCOUNT_SUBSCRIPTIONS_HASH).set(
    targetA,
    JSON.stringify([ownerA.subscriptionId, ownerB.subscriptionId]),
  );
  const removed = await push.removePushSubscription(auth, { allDevices: true });
  assert.equal(removed.ok, false);
  assert.equal(removed.error, "storage_unavailable");
  assert.equal(hash(push.pushInternals.SUBSCRIPTIONS_HASH).has(ownerA.subscriptionId), true);
  assert.equal(hash(push.pushInternals.SUBSCRIPTIONS_HASH).has(ownerB.subscriptionId), true);
});

test("logout then login silently reconciles authVersion before the next delivery", async () => {
  await push.bindPushSubscription(auth, subscription);
  const nextAuth = { ...auth, authVersion: auth.authVersion + 1 };
  strings.set(`lm:user:authver:${auth.email}`, String(nextAuth.authVersion));

  const stale = await push.getPushAccountState(nextAuth);
  assert.equal(stale.subscriptionIds.length, 1);
  assert.equal(stale.validSubscriptionIds.length, 0, "the old session binding is not shown as deliverable");

  const browserSubscription = {
    ...subscription,
    toJSON() { return subscription; },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), "https://www.liumeiti.vip");
    if (url.pathname === "/api/auth/push/subscriptions") {
      const body = JSON.parse(init.body || "{}");
      const result = await push.bindPushSubscription(nextAuth, body.subscription, {
        locale: body.locale,
        preferences: body.preferences,
      });
      return Response.json(result, { status: result.ok ? 200 : 503 });
    }
    return redisFetch(input, init);
  };
  try {
    const reconciled = await pushClient.reconcileBrowserPushSubscription({
      accountState: stale,
      subscription: browserSubscription,
      locale: "zh",
    });
    assert.equal(reconciled.reconciled, true);
  } finally {
    globalThis.fetch = redisFetch;
  }

  const fresh = await push.getPushAccountState(nextAuth);
  assert.deepEqual(fresh.validSubscriptionIds, fresh.subscriptionIds);
  const queued = await push.enqueueOrderPushEvent({
    orderId: "LM-PUSH-RELOGIN",
    userEmail: nextAuth.email,
    accountLifecycleId: nextAuth.accountLifecycleId,
    businessTraceId: "ord_push_relogin",
  }, "order.completed", "relogin-delivery");
  let sends = 0;
  await push.dispatchPushOutbox({ sendNotification: async () => { sends += 1; return { statusCode: 201 }; } });
  assert.equal(sends, 1, "the reconciled device remains deliverable after login");
  const traceRows = lists.get("lm:trace:order:v1:LM-PUSH-RELOGIN") || [];
  assert.equal(traceRows.length, 1);
  const trace = JSON.parse(traceRows[0]);
  assert.equal(trace.stage, "push_delivery");
  assert.equal(trace.outcome, "ok");
  assert.equal(trace.operationId, queued.eventId);
});

test("a VAPID key rotation marks old browser bindings invalid and removes them without a provider send", async () => {
  const bound = await push.bindPushSubscription(auth, subscription);
  assert.equal(bound.ok, true);
  const priorPublicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const priorPrivateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const rotatedVapid = createECDH("prime256v1");
  rotatedVapid.setPrivateKey(Buffer.alloc(32, 21));
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = rotatedVapid.getPublicKey().toString("base64url");
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = rotatedVapid.getPrivateKey().toString("base64url");
  try {
    const state = await push.getPushAccountState(auth);
    assert.deepEqual(state.validSubscriptionIds, []);
    await push.enqueueOrderPushEvent({
      orderId: "LM-PUSH-VAPID-ROTATION",
      userEmail: auth.email,
      accountLifecycleId: auth.accountLifecycleId,
    }, "order.completed", "vapid-rotation");
    let sends = 0;
    const result = await push.dispatchPushOutbox({ sendNotification: async () => { sends += 1; } });
    assert.equal(result.ok, true);
    assert.equal(sends, 0);
    assert.equal(hash(push.pushInternals.SUBSCRIPTIONS_HASH).has(bound.subscriptionId), false);
  } finally {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = priorPublicKey;
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = priorPrivateKey;
  }
});

test("enqueue recovery records and removes its hash/index atomically", async () => {
  const order = {
    orderId: "LM-PUSH-RECOVERY-ATOMIC",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
  };
  failRedisOnce((command) => command[0] === "EVAL" && command[1].includes("return 'queued'"));
  const failed = await push.enqueueOrderPushEvent(order, "order.completed", "recovery-atomic");
  assert.equal(failed.ok, false);
  assert.equal(failed.recoveryRecorded, true);
  assert.equal(hash(push.pushInternals.ENQUEUE_RECOVERY_HASH).size, 1);
  assert.equal(sortedSet(push.pushInternals.ENQUEUE_RECOVERY_INDEX).size, 1);

  const recovered = await push.recoverPushEnqueueFailures({ now: Date.now() + 60_000 });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, 1);
  assert.equal(hash(push.pushInternals.ENQUEUE_RECOVERY_HASH).size, 0);
  assert.equal(sortedSet(push.pushInternals.ENQUEUE_RECOVERY_INDEX).size, 0);
  assert.equal(hash(push.pushInternals.EVENTS_HASH).size, 1);
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).size, 1);
});

test("a failed atomic recovery write cannot leave an unindexed orphan or claim success", async () => {
  failRedisOnce((command) => command[0] === "EVAL" && command[1].includes("return 'queued'"));
  failRedisOnce((command) => command[0] === "EVAL" && command[1].includes("return prior and 'updated' or 'saved'"));
  const failed = await push.enqueueOrderPushEvent({
    orderId: "LM-PUSH-RECOVERY-FAULT",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
  }, "order.completed", "recovery-fault");
  assert.equal(failed.ok, false);
  assert.equal(failed.recoveryRecorded, false);
  assert.equal(hash(push.pushInternals.ENQUEUE_RECOVERY_HASH).size, 0);
  assert.equal(sortedSet(push.pushInternals.ENQUEUE_RECOVERY_INDEX).size, 0);
});

test("concurrent order event enqueue is idempotent and dispatcher lock sends once", async () => {
  await push.bindPushSubscription(auth, subscription, { locale: "en" });
  const order = {
    orderId: "LM-PUSH-1",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
    locale: "en",
  };
  const queued = await Promise.all(Array.from({ length: 30 }, () => (
    push.enqueueOrderPushEvent(order, "order.completed", "operation-1")
  )));
  assert.ok(queued.every((result) => result.ok && result.queued));
  assert.equal(hash(push.pushInternals.EVENTS_HASH).size, 1);
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).size, 1);

  let sends = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sender = async () => { sends += 1; await gate; return { statusCode: 201 }; };
  const first = push.dispatchPushOutbox({ sendNotification: sender });
  const second = push.dispatchPushOutbox({ sendNotification: sender });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const summaries = await Promise.all([first, second]);
  assert.equal(sends, 1);
  assert.ok(summaries.some((summary) => summary.locked));
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).size, 0);
});

test("dispatch lock heartbeat prevents overlap after the original TTL", async () => {
  await push.bindPushSubscription(auth, subscription);
  await push.bindPushSubscription(auth, {
    ...subscription,
    endpoint: "https://fcm.googleapis.com/fcm/send/heartbeat-second-device",
  });
  await push.enqueueOrderPushEvent({
    orderId: "LM-PUSH-HEARTBEAT",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
  }, "order.completed", "heartbeat-operation");

  const realDateNow = Date.now;
  let fakeNow = realDateNow();
  Date.now = () => fakeNow;
  let sends = 0;
  let markSecondStarted;
  let releaseSecond;
  const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  try {
    const first = push.dispatchPushOutbox({
      timeBudgetMs: 40_000,
      sendNotification: async () => {
        sends += 1;
        fakeNow += 30_000;
        if (sends === 2) {
          markSecondStarted();
          await secondGate;
        }
        return { statusCode: 201 };
      },
    });
    await secondStarted;
    assert.ok(fakeNow - (realDateNow()) >= 55_000, "virtual clock crossed the original 55 second lease");
    const overlap = await push.dispatchPushOutbox({ sendNotification: async () => { sends += 1; } });
    assert.equal(overlap.locked, true, "heartbeat kept the token lease owned by the first worker");
    assert.equal(sends, 2);
    releaseSecond();
    const completed = await first;
    assert.equal(completed.sent, 2);
  } finally {
    Date.now = realDateNow;
    releaseSecond?.();
  }
});

test("stock events with many empty targets stop on lock loss before scanning the target list", async () => {
  const productKey = "ai:many-empty-lock";
  const targets = Array.from({ length: 20 }, (_, index) => `empty-target-${index}`);
  strings.set("liumeiti:stock:ai:many-empty-lock", "1");
  hash(push.pushInternals.STOCK_WATCHES_HASH).set(productKey, JSON.stringify(targets));
  const queued = await push.enqueueRestockPushEvent("ai", "many-empty-lock", "many-empty-lock");
  let refreshCalls = 0;
  failRedisOnce((command) => {
    if (command[0] !== "EVAL" || !command[1].includes("return redis.call('EXPIRE',KEYS[1],ARGV[2])")) return false;
    refreshCalls += 1;
    return refreshCalls === 2;
  }, { result: 0 });
  const result = await push.dispatchPushOutbox({ sendNotification: async () => { throw new Error("must not send"); } });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.equal(result.stopReason, "lock_lost");
  assert.equal(refreshCalls, 2, "one outer check and one target-boundary check are enough to stop");
  assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), true);
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).has(queued.eventId), true);
});

test("stock events with many empty targets enforce the time budget at target boundaries", async () => {
  const productKey = "ai:many-empty-budget";
  const targets = Array.from({ length: 20 }, (_, index) => `budget-target-${index}`);
  strings.set("liumeiti:stock:ai:many-empty-budget", "1");
  hash(push.pushInternals.STOCK_WATCHES_HASH).set(productKey, JSON.stringify(targets));
  const queued = await push.enqueueRestockPushEvent("ai", "many-empty-budget", "many-empty-budget");
  let time = 0;
  const result = await push.dispatchPushOutbox({
    timeBudgetMs: 5_000,
    clock: () => { time += 2_000; return time; },
    sendNotification: async () => { throw new Error("must not send"); },
  });
  assert.equal(result.ok, true, "a budget stop is controlled backpressure, not data loss");
  assert.equal(result.stopped, true);
  assert.equal(result.stopReason, "time_budget");
  assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), true);
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).has(queued.eventId), true);
});

test("410 removes a dead subscription while 503 keeps an event retryable", async () => {
  await push.bindPushSubscription(auth, subscription);
  const order = {
    orderId: "LM-PUSH-GONE",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
  };
  await push.enqueueOrderPushEvent(order, "order.completed", "gone");
  const gone = await push.dispatchPushOutbox({
    sendNotification: async () => { const error = new Error("gone"); error.statusCode = 410; throw error; },
  });
  assert.equal(gone.removed, 1);
  assert.equal(hash(push.pushInternals.SUBSCRIPTIONS_HASH).size, 0);

  await push.bindPushSubscription(auth, subscription);
  await push.enqueueOrderPushEvent(order, "order.payment_confirmed", "retry");
  const retry = await push.dispatchPushOutbox({
    now: Date.now() + 1,
    sendNotification: async () => { const error = new Error("temporary"); error.statusCode = 503; throw error; },
  });
  assert.equal(retry.retried, 1);
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).size, 1);
});

test("provider 400 is terminal, keeps the subscription, and creates an operational alert", async () => {
  await push.bindPushSubscription(auth, subscription);
  await push.enqueueOrderPushEvent({
    orderId: "LM-PUSH-400",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
  }, "order.completed", "provider-400");
  const result = await push.dispatchPushOutbox({
    sendNotification: async () => { const error = new Error("bad web-push request"); error.statusCode = 400; throw error; },
  });
  assert.equal(result.retried, 0);
  assert.equal(hash(push.pushInternals.SUBSCRIPTIONS_HASH).size, 1, "400 is not proof that the endpoint is gone");
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).size, 0, "400 is terminal for this event");
  assert.equal(sortedSet(push.pushInternals.PROVIDER_ALERTS_INDEX).size, 1);
  const alert = JSON.parse([...hash(push.pushInternals.PROVIDER_ALERTS_HASH).values()][0]);
  assert.equal(alert.statusCode, 400);
});

test("provider authentication failures retry but create only one durable alert per delivery", async () => {
  await push.bindPushSubscription(auth, subscription);
  await push.enqueueOrderPushEvent({
    orderId: "LM-PUSH-403",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
  }, "order.completed", "provider-403");
  const rejected = async () => { const error = new Error("vapid rejected"); error.statusCode = 403; throw error; };
  const first = await push.dispatchPushOutbox({ sendNotification: rejected });
  const second = await push.dispatchPushOutbox({ now: Date.now() + 60_000, sendNotification: rejected });
  assert.equal(first.retried, 1);
  assert.equal(second.retried, 1);
  assert.equal(hash(push.pushInternals.SUBSCRIPTIONS_HASH).size, 1);
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).size, 1);
  assert.equal(hash(push.pushInternals.PROVIDER_ALERTS_HASH).size, 1);
  assert.equal(sortedSet(push.pushInternals.PROVIDER_ALERTS_INDEX).size, 1);
});

test("idle subscription cleanup persists and resumes its HSCAN cursor", async () => {
  await push.bindPushSubscription(auth, subscription);
  await push.bindPushSubscription(auth, {
    ...subscription,
    endpoint: "https://fcm.googleapis.com/fcm/send/push-test-endpoint-two",
  });
  const records = hash(push.pushInternals.SUBSCRIPTIONS_HASH);
  for (const [id, raw] of records) {
    records.set(id, JSON.stringify({
      ...JSON.parse(raw),
      createdAt: "2020-01-01T00:00:00.000Z",
      lastSeenAt: "2020-01-01T00:00:00.000Z",
      lastSuccessAt: "",
    }));
  }
  const first = await push.cleanupExpiredPushSubscriptions({ now: Date.now(), limit: 1 });
  assert.equal(first.startCursor, "0");
  assert.equal(first.nextCursor, "17");
  assert.equal(first.removed, 1);
  const second = await push.cleanupExpiredPushSubscriptions({ now: Date.now(), limit: 1 });
  assert.equal(second.startCursor, "17");
  assert.equal(second.nextCursor, "0");
  assert.equal(second.removed, 1);
  assert.equal(strings.get(push.pushInternals.SUBSCRIPTION_CLEANUP_CURSOR_KEY), "0");
});

test("subscription cleanup reports a corrupt record removal failure instead of a healthy scan", async () => {
  const bound = await push.bindPushSubscription(auth, subscription);
  assert.equal(bound.ok, true);
  hash(push.pushInternals.SUBSCRIPTIONS_HASH).set(bound.subscriptionId, "{corrupt-record");
  const cleanup = await push.cleanupExpiredPushSubscriptions({ now: Date.now(), limit: 10 });
  assert.equal(cleanup.ok, false);
  assert.equal(cleanup.error, "storage_unavailable");
  assert.equal(cleanup.failed, 1);
  assert.equal(hash(push.pushInternals.SUBSCRIPTIONS_HASH).has(bound.subscriptionId), true);
});

test("successful delivery activity prevents cleanup even when lastSeenAt is old", async () => {
  await push.bindPushSubscription(auth, subscription);
  const records = hash(push.pushInternals.SUBSCRIPTIONS_HASH);
  for (const [id, raw] of records) {
    records.set(id, JSON.stringify({
      ...JSON.parse(raw),
      createdAt: "2020-01-01T00:00:00.000Z",
      lastSeenAt: "2020-01-01T00:00:00.000Z",
      lastSuccessAt: new Date().toISOString(),
    }));
  }
  const result = await push.cleanupExpiredPushSubscriptions({ now: Date.now(), limit: 10 });
  assert.equal(result.removed, 0);
  assert.equal(records.size, 1);
});

test("preference storage faults neither overwrite an opt-out nor bypass it during delivery", async () => {
  await push.bindPushSubscription(auth, subscription);
  const target = push.pushAccountTarget(auth.email, auth.accountLifecycleId);
  const disabled = await push.updatePushPreferences(auth, { enabled: false, orders: false });
  assert.equal(disabled.ok, true);
  const preferenceKey = push.pushInternals.PREFERENCES_HASH;
  const originalPreference = hash(preferenceKey).get(target);

  failRedisOnce((command) => command[0] === "HMGET" && command[1] === preferenceKey && command[2] === target);
  const rebound = await push.bindPushSubscription(auth, subscription, { preferences: { enabled: true, orders: true } });
  assert.deepEqual(rebound, { ok: false, error: "storage_unavailable" });
  assert.equal(hash(preferenceKey).get(target), originalPreference);

  failRedisOnce((command) => command[0] === "HMGET" && command[1] === preferenceKey && command[2] === target);
  const updated = await push.updatePushPreferences(auth, { enabled: true, orders: true });
  assert.deepEqual(updated, { ok: false, error: "storage_unavailable" });
  assert.equal(hash(preferenceKey).get(target), originalPreference);

  const queued = await push.enqueueOrderPushEvent({
    orderId: "LM-PUSH-PREF-FAULT",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
  }, "order.completed", "preference-fault");
  let sends = 0;
  failRedisOnce((command) => command[0] === "HMGET" && command[1] === preferenceKey && command[2] === target);
  const result = await push.dispatchPushOutbox({ sendNotification: async () => { sends += 1; } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "storage_unavailable");
  assert.equal(sends, 0);
  assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), true);
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).has(queued.eventId), true);
});

test("account Push API returns 503 instead of fake-empty state for every account-field read fault", async () => {
  await push.bindPushSubscription(auth, subscription);
  const target = push.pushAccountTarget(auth.email, auth.accountLifecycleId);
  const token = authSessions.signUserSessionForVersion(auth.email, auth.authVersion);
  const fields = [
    push.pushInternals.ACCOUNT_SUBSCRIPTIONS_HASH,
    push.pushInternals.PREFERENCES_HASH,
    push.pushInternals.ACCOUNT_WATCHES_HASH,
  ];
  for (const key of fields) {
    failRedisOnce((command) => command[0] === "HMGET" && command[1] === key && command[2] === target);
    const response = await pushSubscriptionsRoute.GET(new Request("https://www.liumeiti.vip/api/auth/push/subscriptions", {
      headers: { cookie: `lm_user=${encodeURIComponent(token)}` },
    }));
    assert.equal(response.status, 503, key);
    assert.deepEqual(await response.json(), { ok: false, status: 503, error: "storage_unavailable" });
  }
  failRedisOnce(
    (command) => command[0] === "HMGET" && command[1] === push.pushInternals.PREFERENCES_HASH,
    { result: [] },
  );
  const shortResponse = await pushSubscriptionsRoute.GET(new Request("https://www.liumeiti.vip/api/auth/push/subscriptions", {
    headers: { cookie: `lm_user=${encodeURIComponent(token)}` },
  }));
  assert.equal(shortResponse.status, 503);
  assert.equal((await shortResponse.json()).error, "storage_unavailable");
});

test("stock target GET and watch HGET faults retain and reschedule the event", async () => {
  for (const faultKind of ["stock", "watches"]) {
    strings.clear();
    expirations.clear();
    hashes.clear();
    sortedSets.clear();
    lists.clear();
    redisFaults = [];
    seedAuthState();
    await push.bindPushSubscription(auth, subscription);
    const target = push.pushAccountTarget(auth.email, auth.accountLifecycleId);
    const productKey = `ai:fault-${faultKind}`;
    strings.set(`liumeiti:stock:ai:fault-${faultKind}`, "1");
    hash(push.pushInternals.STOCK_WATCHES_HASH).set(productKey, JSON.stringify([target]));
    hash(push.pushInternals.ACCOUNT_WATCHES_HASH).set(target, JSON.stringify([productKey]));
    const queued = await push.enqueueRestockPushEvent("ai", `fault-${faultKind}`, `target-${faultKind}`);
    failRedisOnce((command) => faultKind === "stock"
      ? command[0] === "MGET" && command[1] === `liumeiti:stock:ai:fault-${faultKind}`
      : command[0] === "HMGET" && command[1] === push.pushInternals.STOCK_WATCHES_HASH && command[2] === productKey);
    let sends = 0;
    const result = await push.dispatchPushOutbox({ sendNotification: async () => { sends += 1; } });
    assert.equal(result.ok, false, faultKind);
    assert.equal(result.error, "storage_unavailable", faultKind);
    assert.equal(sends, 0, faultKind);
    assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), true, faultKind);
    assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).has(queued.eventId), true, faultKind);
    assert.equal(hash(push.pushInternals.STOCK_WATCHES_HASH).has(productKey), true, faultKind);
  }
});

test("subscription index, subscription record and delivery reads fail closed without deleting events", async () => {
  for (const key of [
    push.pushInternals.ACCOUNT_SUBSCRIPTIONS_HASH,
    push.pushInternals.SUBSCRIPTIONS_HASH,
    push.pushInternals.DELIVERIES_HASH,
  ]) {
    strings.clear();
    expirations.clear();
    hashes.clear();
    sortedSets.clear();
    lists.clear();
    redisFaults = [];
    seedAuthState();
    await push.bindPushSubscription(auth, subscription);
    const queued = await push.enqueueOrderPushEvent({
      orderId: `LM-PUSH-READ-${key.split(":").at(-2)}`,
      userEmail: auth.email,
      accountLifecycleId: auth.accountLifecycleId,
    }, "order.completed", `read-${key}`);
    failRedisOnce((command) => command[0] === "HMGET" && command[1] === key);
    let sends = 0;
    const result = await push.dispatchPushOutbox({ sendNotification: async () => { sends += 1; } });
    assert.equal(result.ok, false, key);
    assert.equal(result.error, "storage_unavailable", key);
    assert.equal(sends, 0, key);
    assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), true, key);
    assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).has(queued.eventId), true, key);
  }
});

test("an atomic reschedule failure leaves both the event and its due index recoverable", async () => {
  await push.bindPushSubscription(auth, subscription);
  const target = push.pushAccountTarget(auth.email, auth.accountLifecycleId);
  const queued = await push.enqueueOrderPushEvent({
    orderId: "LM-PUSH-RESCHEDULE-FAULT",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
  }, "order.completed", "reschedule-fault");
  failRedisOnce((command) => command[0] === "HMGET" && command[1] === push.pushInternals.PREFERENCES_HASH && command[2] === target);
  failRedisOnce((command) => command[0] === "EVAL" && command[1].includes("return 'rescheduled'"));
  const result = await push.dispatchPushOutbox({ sendNotification: async () => { throw new Error("must not send"); } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "storage_unavailable");
  assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), true);
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).has(queued.eventId), true);
  assert.equal(JSON.parse(hash(push.pushInternals.EVENTS_HASH).get(queued.eventId)).attempts, 0);
});

test("failed success/final commits recover without a duplicate provider send", async () => {
  await push.bindPushSubscription(auth, subscription);
  const queued = await push.enqueueOrderPushEvent({
    orderId: "LM-PUSH-COMMIT-RECOVERY",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
  }, "order.completed", "commit-recovery");
  let sends = 0;
  failRedisOnce((command) => command[0] === "EVAL" && command[1].includes("redis.call('HSET',KEYS[2],ARGV[3],ARGV[4])"));
  const first = await push.dispatchPushOutbox({ sendNotification: async () => { sends += 1; } });
  assert.equal(first.ok, false);
  assert.equal(first.error, "storage_unavailable");
  assert.equal(sends, 1);
  assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), true);

  failRedisOnce((command) => command[0] === "EVAL" && command[1].includes("local deliveryCount=") && command[1].includes("return 'finalized'"));
  const second = await push.dispatchPushOutbox({ now: Date.now() + 60_000, sendNotification: async () => { sends += 1; } });
  assert.equal(second.ok, false);
  assert.equal(second.error, "storage_unavailable");
  assert.equal(sends, 1, "a durable sending marker prevents a duplicate after an uncertain provider commit");
  assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), true);

  const recovered = await push.dispatchPushOutbox({ now: Date.now() + 60_000, sendNotification: async () => { sends += 1; } });
  assert.equal(recovered.ok, true);
  assert.equal(sends, 1);
  assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), false);
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).has(queued.eventId), false);
});

test("failed stock finalization keeps watches until an atomic retry succeeds", async () => {
  await push.bindPushSubscription(auth, subscription);
  const target = push.pushAccountTarget(auth.email, auth.accountLifecycleId);
  const productKey = "ai:atomic-final";
  strings.set("liumeiti:stock:ai:atomic-final", "1");
  hash(push.pushInternals.STOCK_WATCHES_HASH).set(productKey, JSON.stringify([target]));
  hash(push.pushInternals.ACCOUNT_WATCHES_HASH).set(target, JSON.stringify([productKey]));
  const queued = await push.enqueueRestockPushEvent("ai", "atomic-final", "atomic-final");
  let sends = 0;
  failRedisOnce((command) => command[0] === "EVAL" && command[1].includes("local deliveryCount=") && command[1].includes("return 'finalized'"));
  const failed = await push.dispatchPushOutbox({ sendNotification: async () => { sends += 1; } });
  assert.equal(failed.ok, false);
  assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), true);
  assert.equal(hash(push.pushInternals.STOCK_WATCHES_HASH).has(productKey), true);
  assert.equal(hash(push.pushInternals.ACCOUNT_WATCHES_HASH).has(target), true);

  const recovered = await push.dispatchPushOutbox({ sendNotification: async () => { sends += 1; } });
  assert.equal(recovered.ok, true);
  assert.equal(sends, 1);
  assert.equal(hash(push.pushInternals.EVENTS_HASH).has(queued.eventId), false);
  assert.equal(hash(push.pushInternals.STOCK_WATCHES_HASH).has(productKey), false);
  assert.equal(hash(push.pushInternals.ACCOUNT_WATCHES_HASH).has(target), false);
});

test("dispatch lock storage failure is not reported as a healthy competing lock", async () => {
  failRedisOnce((command) => command[0] === "SET" && command[1] === "lm:push:dispatch-lock:v1");
  const result = await push.dispatchPushOutbox();
  assert.equal(result.ok, false);
  assert.equal(result.error, "storage_unavailable");
  assert.equal(result.locked, undefined);

  failRedisOnce((command) => command[0] === "SET" && command[1] === "lm:push:dispatch-lock:v1");
  failRedisOnce(
    (command) => command[0] === "MGET" && command[1] === "lm:push:dispatch-lock:v1",
    { result: [] },
  );
  const shortProbe = await push.dispatchPushOutbox();
  assert.equal(shortProbe.ok, false);
  assert.equal(shortProbe.error, "storage_unavailable");

  strings.set("lm:push:dispatch-lock:v1", "other-worker");
  const locked = await push.dispatchPushOutbox();
  assert.equal(locked.ok, true);
  assert.equal(locked.locked, true);
});

test("provider alerts age out atomically and queue stats count only the retention window", async () => {
  const now = Date.now();
  const oldId = "provider-alert-old";
  const freshId = "provider-alert-fresh";
  hash(push.pushInternals.PROVIDER_ALERTS_HASH).set(oldId, JSON.stringify({ alertId: oldId }));
  hash(push.pushInternals.PROVIDER_ALERTS_HASH).set(freshId, JSON.stringify({ alertId: freshId }));
  sortedSet(push.pushInternals.PROVIDER_ALERTS_INDEX).set(oldId, now - push.pushInternals.PROVIDER_ALERT_RETENTION_MS - 1);
  sortedSet(push.pushInternals.PROVIDER_ALERTS_INDEX).set(freshId, now - 1_000);
  const before = await push.readPushQueueStats();
  assert.equal(before.providerAlerts, 1);
  const cleaned = await push.cleanupExpiredPushProviderAlerts({ now, limit: 10 });
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.removed, 1);
  assert.equal(hash(push.pushInternals.PROVIDER_ALERTS_HASH).has(oldId), false);
  assert.equal(sortedSet(push.pushInternals.PROVIDER_ALERTS_INDEX).has(oldId), false);
  assert.equal(hash(push.pushInternals.PROVIDER_ALERTS_HASH).has(freshId), true);
});

test("Push queue stats distinguish an empty queue from an unavailable Redis read", async () => {
  const empty = await push.readPushQueueStats();
  assert.deepEqual(empty, {
    ok: true,
    subscriptions: 0,
    queued: 0,
    events: 0,
    enqueueRecovery: 0,
    providerAlerts: 0,
  });

  failRedisOnce(
    (command) => command[0] === "ZCOUNT" && command[1] === push.pushInternals.PROVIDER_ALERTS_INDEX,
    { result: [] },
  );
  assert.deepEqual(await push.readPushQueueStats(), {
    ok: false,
    error: "push_queue_stats_unavailable",
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const command = url.pathname.split("/").slice(1).filter(Boolean).map(decodeURIComponent);
    if (command[0]?.toUpperCase() === "ZCOUNT" && command[1] === push.pushInternals.PROVIDER_ALERTS_INDEX) {
      return Response.json({ error: "redis_unavailable" }, { status: 503 });
    }
    return redisFetch(input, init);
  };
  try {
    assert.deepEqual(await push.readPushQueueStats(), {
      ok: false,
      error: "push_queue_stats_unavailable",
    });
  } finally {
    globalThis.fetch = redisFetch;
  }
});

test("Push cron returns 503 when queue telemetry is unavailable", async () => {
  failRedisOnce(
    (command) => command[0] === "ZCOUNT" && command[1] === push.pushInternals.PROVIDER_ALERTS_INDEX,
    { result: [] },
  );
  const response = await pushCronRoute.GET(new Request("https://www.liumeiti.vip/api/cron/push", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.stats.ok, false);
});

test("only a real 0 to available stock edge queues a restock event under concurrency", async () => {
  strings.set("liumeiti:stock:ai:gpt-plus", "0");
  const first = await Promise.all(Array.from({ length: 25 }, () => (
    push.setStockAndMaybeEnqueueRestock("ai", "gpt-plus", 5, "stock-operation-1")
  )));
  assert.equal(first.filter((result) => result.restocked).length, 1);
  assert.equal(hash(push.pushInternals.EVENTS_HASH).size, 1);
  assert.equal(sortedSet(push.pushInternals.OUTBOX_KEY).size, 1);

  await push.setStockAndMaybeEnqueueRestock("ai", "gpt-plus", 8, "stock-operation-2");
  assert.equal(hash(push.pushInternals.EVENTS_HASH).size, 1, "positive to positive must not notify");
  await push.setStockAndMaybeEnqueueRestock("ai", "gpt-plus", 0, "stock-operation-3");
  await push.setStockAndMaybeEnqueueRestock("ai", "gpt-plus", "", "stock-operation-4");
  assert.equal(hash(push.pushInternals.EVENTS_HASH).size, 2, "zero to unlimited is a new availability edge");
});

test("a reused stock operation id with different notification semantics cannot mutate stock", async () => {
  strings.set("liumeiti:stock:ai:operation-conflict", "0");
  const first = await push.setStockAndMaybeEnqueueRestock(
    "ai",
    "operation-conflict",
    5,
    "same-operation",
    { planLabelEn: "Original label" },
  );
  assert.equal(first.ok, true);
  await push.setStockAndMaybeEnqueueRestock("ai", "operation-conflict", 0, "reset-operation");
  const conflict = await push.setStockAndMaybeEnqueueRestock(
    "ai",
    "operation-conflict",
    9,
    "same-operation",
    { planLabelEn: "Changed label" },
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "push_event_conflict");
  assert.equal(strings.get("liumeiti:stock:ai:operation-conflict"), "0");
});

test("service worker is network-cache free, same-origin fixed-icon and subscription-change safe", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /addEventListener\(["']fetch["']/);
  assert.match(source, /renotify:\s*false/);
  assert.match(source, /icon:\s*["']\/icon-192\.png["']/);
  assert.match(source, /badge:\s*["']\/icon-192\.png["']/);
  assert.doesNotMatch(source, /value\.icon|value\.badge/);
  assert.match(source, /addEventListener\(["']pushsubscriptionchange["']/);
  assert.match(source, /credentials:\s*["']include["']/);
  assert.match(source, /text\.startsWith\(["']\/\/["']\)/);
});

test("notification clicks open the safe target when an existing window cannot navigate", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = new Map();
  let focused = 0;
  let opened = "";
  const existing = {
    url: "https://www.liumeiti.vip/shop",
    focus: async () => { focused += 1; },
  };
  const serviceWorker = {
    location: { origin: "https://www.liumeiti.vip" },
    addEventListener(type, listener) { listeners.set(type, listener); },
    skipWaiting() {},
    registration: {},
    clients: {
      claim: async () => {},
      matchAll: async () => [existing],
      openWindow: async (url) => { opened = url; return { url }; },
    },
  };
  runInNewContext(source, {
    self: serviceWorker,
    URL,
    Promise,
    Date,
    Uint8Array,
    atob,
    indexedDB: {},
  });
  let pending = null;
  listeners.get("notificationclick")({
    notification: {
      close() {},
      data: { url: "/account?order=LM-PUSH-CLICK" },
    },
    waitUntil(value) { pending = value; },
  });
  await pending;
  assert.equal(focused, 0, "an unrelated page is not focused when it cannot navigate");
  assert.equal(opened, "https://www.liumeiti.vip/account?order=LM-PUSH-CLICK");
});

test("web-push is statically traceable and has a bounded provider timeout", async () => {
  const source = await readFile(new URL("../app/api/_push.js", import.meta.url), "utf8");
  assert.match(source, /import webpush from ["']web-push["']/);
  assert.doesNotMatch(source, /import\(packageName\)|import\(["']web-push["']\)/);
  assert.match(source, /timeout:\s*WEB_PUSH_TIMEOUT_MS/);
  assert.match(source, /const WEB_PUSH_TIMEOUT_MS\s*=\s*10_000/);
  assert.match(source, /\[404, 410\]\.includes\(statusCode\)/);
  assert.doesNotMatch(source, /\[400, 404, 410\]/);
  assert.match(source, /REFRESH_DISPATCH_LOCK_SCRIPT/);
  assert.match(source, /await lease\.check\(\)/);
});

test("stock alert preflights once on mount and enters permission flow before network work on click", async () => {
  const [component, client, settings] = await Promise.all([
    readFile(new URL("../app/components/StockAlertButton.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/push-client.js", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PushNotificationSettings.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(component, /useEffect\(\(\) =>[\s\S]*fetchPushAccountStateCached\(\)/);
  assert.match(component, /stockWatches \|\| \[\]\)\.includes\(productKey\)/);
  assert.match(component, /status === "auth_required"[\s\S]*window\.location\.assign\("\/account"\)/);
  const toggle = component.slice(component.indexOf("async function toggle"), component.lastIndexOf("return ("));
  assert.doesNotMatch(toggle, /fetchPushAccountState/);
  assert.ok(toggle.indexOf("enableBrowserPush") < toggle.indexOf("setStockPushWatch(service, plan, true)"));
  const enable = client.slice(client.indexOf("export async function enableBrowserPush"), client.indexOf("export async function disableBrowserPush"));
  assert.ok(enable.indexOf("Notification.requestPermission") < enable.indexOf("fetch(\"/api/auth/push/config\""));
  assert.match(enable, /Promise\.race\(\[Notification\.requestPermission\(\), promptTimeout\]\)/);
  assert.match(enable, /push_permission_prompt_missing/);
  assert.match(settings, /push_permission_required/);
  assert.match(settings, /15 秒内未收到浏览器权限结果/);
  assert.match(component, /code\.includes\("push_permission_prompt_missing"\)/);
  assert.match(component, /code\.includes\("push_permission_required"\)/);
  assert.match(component, /15 秒内未收到浏览器权限结果/);
  assert.match(component, /role=\{status === "error" \? "alert" : "status"\}/);
  assert.match(client, /let pushAccountStatePromise = null/);
  assert.match(client, /invalidatePushAccountStateCache\(\)/);
  assert.match(settings, /reconcileBrowserPushSubscription\(\{ accountState, subscription, locale \}\)/);
  assert.match(settings, /hasRemotePushSubscription\(state, currentSubscriptionId\)/);
  assert.doesNotMatch(settings, /subscriptionIds\?\.length[^\n]*>\s*1/);
  assert.match(component, /const buttonDisabled\s*=\s*busy \|\| \["checking", "unavailable", "available"\]\.includes\(status\)/);
  assert.match(component, /cursor:\s*busy \? "wait" : buttonDisabled \? "not-allowed" : "pointer"/);
  assert.match(component, /const wasWatching = watching[\s\S]*setStatus\(wasWatching \? "watching" : "error"\)/);
});

test("remote Push device detection prefers valid subscriptions and handles a single remote device", () => {
  assert.equal(pushClient.hasRemotePushSubscription({
    subscriptionIds: ["remote-only"],
    validSubscriptionIds: ["remote-only"],
  }, ""), true, "a sole subscription is remote when this browser has none");
  assert.equal(pushClient.hasRemotePushSubscription({
    subscriptionIds: ["this-device"],
    validSubscriptionIds: ["this-device"],
  }, "this-device"), false);
  assert.equal(pushClient.hasRemotePushSubscription({
    subscriptionIds: ["this-device", "remote-device"],
    validSubscriptionIds: ["this-device", "remote-device"],
  }, "this-device"), true);
  assert.equal(pushClient.hasRemotePushSubscription({
    subscriptionIds: ["stale-remote"],
    validSubscriptionIds: [],
  }, ""), false, "an explicit valid list takes precedence over stale account bindings");
  assert.equal(pushClient.hasRemotePushSubscription({ subscriptionIds: ["legacy-remote"] }, ""), true);
});

test("client detects a browser subscription created with a stale VAPID key", () => {
  const expected = Buffer.from(process.env.WEB_PUSH_VAPID_PUBLIC_KEY, "base64url");
  const changed = Buffer.from(expected);
  changed[changed.length - 1] ^= 1;
  assert.equal(pushClient.pushSubscriptionMatchesVapidKey({
    options: { applicationServerKey: expected.buffer.slice(expected.byteOffset, expected.byteOffset + expected.byteLength) },
  }, process.env.WEB_PUSH_VAPID_PUBLIC_KEY), true);
  assert.equal(pushClient.pushSubscriptionMatchesVapidKey({
    options: { applicationServerKey: changed.buffer.slice(changed.byteOffset, changed.byteOffset + changed.byteLength) },
  }, process.env.WEB_PUSH_VAPID_PUBLIC_KEY), false);
  assert.equal(pushClient.pushSubscriptionMatchesVapidKey({ options: {} }, process.env.WEB_PUSH_VAPID_PUBLIC_KEY), true);
});

test("delivery tracing records one retry and one final result per event without PII", async () => {
  await push.bindPushSubscription(auth, subscription);
  const queued = await push.enqueueOrderPushEvent({
    orderId: "LM-PUSH-TRACE",
    userEmail: auth.email,
    accountLifecycleId: auth.accountLifecycleId,
    businessTraceId: "ord_push_trace",
  }, "order.payment_confirmed", "trace-retry");
  const temporaryFailure = async () => {
    const error = new Error("provider temporarily unavailable");
    error.statusCode = 503;
    throw error;
  };
  await push.dispatchPushOutbox({ sendNotification: temporaryFailure });
  await push.dispatchPushOutbox({ now: Date.now() + 60_000, sendNotification: temporaryFailure });
  let traceRows = lists.get("lm:trace:order:v1:LM-PUSH-TRACE") || [];
  assert.equal(traceRows.length, 1, "repeated retries share one durable retry marker");
  assert.equal(JSON.parse(traceRows[0]).outcome, "retry");

  await push.dispatchPushOutbox({
    now: Date.now() + 10 * 60_000,
    sendNotification: async () => ({ statusCode: 201 }),
  });
  traceRows = lists.get("lm:trace:order:v1:LM-PUSH-TRACE") || [];
  assert.equal(traceRows.length, 2, "the final result is recorded once after retry recovery");
  const traces = traceRows.map(JSON.parse);
  assert.ok(traces.every((row) => row.operationId === queued.eventId));
  assert.ok(traces.every((row) => !JSON.stringify(row).includes(auth.email)));
  assert.ok(traces.every((row) => !JSON.stringify(row).includes(subscription.endpoint)));
});

test("stock-watch mutations invalidate shared preflight cache for a remount", async () => {
  let accountFetches = 0;
  let watched = false;
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input), "https://www.liumeiti.vip").pathname;
    if (path === "/api/auth/push/subscriptions") {
      accountFetches += 1;
      return Response.json({
        ok: true,
        enabled: true,
        configured: true,
        preferences: {},
        subscriptionIds: [],
        stockWatches: watched ? ["ai:gpt-plus"] : [],
      });
    }
    if (path === "/api/auth/push/stock-watches") {
      watched = String(init.method || "GET").toUpperCase() === "POST";
      return Response.json({ ok: true, watching: watched, productKey: "ai:gpt-plus" });
    }
    throw new Error(`unexpected client fetch ${path}`);
  };
  try {
    const initial = await pushClient.fetchPushAccountStateCached({ refresh: true });
    const shared = await pushClient.fetchPushAccountStateCached();
    assert.equal(accountFetches, 1);
    assert.deepEqual(initial.stockWatches, shared.stockWatches);

    await pushClient.setStockPushWatch("ai", "gpt-plus", true);
    const afterAddRemount = await pushClient.fetchPushAccountStateCached();
    assert.equal(accountFetches, 2);
    assert.deepEqual(afterAddRemount.stockWatches, ["ai:gpt-plus"]);

    await pushClient.setStockPushWatch("ai", "gpt-plus", false);
    const afterRemoveRemount = await pushClient.fetchPushAccountStateCached();
    assert.equal(accountFetches, 3);
    assert.deepEqual(afterRemoveRemount.stockWatches, []);
  } finally {
    pushClient.invalidatePushAccountStateCache();
    globalThis.fetch = redisFetch;
  }
});

test("real business event hooks are present and Push remains fail-soft", async () => {
  const files = await Promise.all([
    "../app/api/admin/orders/[orderId]/route.js",
    "../app/api/_order-transition.js",
    "../app/api/after-sales/_completion-effects.js",
    "../app/api/_renewal.js",
    "../app/api/_usdt-confirm.js",
    "../app/api/_quote-expiry.js",
    "../app/api/admin/catalog/route.js",
    "../app/api/admin/stock/route.js",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const joined = files.join("\n");
  for (const call of [
    "enqueueOrderPushEvent",
    "enqueueAfterSalesCompletedPush",
    "enqueueRenewalPushEvent",
    "enqueueRestockPushEvent",
    "setStockAndMaybeEnqueueRestock",
  ]) assert.match(joined, new RegExp(call));
  assert.doesNotMatch(joined, /internalEffectsOk\s*=\s*await enqueueOrderUpdatePush/);
  assert.doesNotMatch(joined, /internalOk\s*=.*push\.ok/);
  assert.doesNotMatch(joined, /restock_push_enqueue_failed/);
  assert.match(joined, /appendBusinessTraceEvent/);
  assert.match(files[6], /catalogCommitted:\s*true/);
  assert.match(files[6], /status:\s*503/);
  assert.match(files[7], /error:\s*"stock_update_failed"/);
  assert.match(files[7], /status:\s*503/);
});
