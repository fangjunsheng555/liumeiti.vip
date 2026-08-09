import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.AUTH_SECRET = "telegram-retry-test-secret-at-least-32-characters";
process.env.KV_REST_API_URL = "http://telegram-retry.redis.test";
process.env.KV_REST_API_TOKEN = "redis-secret-token";
process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-secret-token";
process.env.TELEGRAM_CHAT_ID = "987654";
process.env.OPS_INCIDENT_TELEGRAM_ENABLED = "1";

const strings = new Map();
const lists = new Map();
const sortedSets = new Map();
const telegramResponses = [];
const telegramBodies = [];
let loseRetryUpsertResponse = false;
let failRetryRecoveryPipelineOnce = false;
let failExactInvalidCleanupOnce = false;
const originalFetch = globalThis.fetch;

function sortedSet(key) {
  if (!sortedSets.has(key)) sortedSets.set(key, new Map());
  return sortedSets.get(key);
}

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "PING") return "PONG";
  if (name === "GET") return strings.get(args[0]) ?? null;
  if (name === "SET") {
    const [key, value, ...options] = args;
    if (options.map((item) => String(item).toUpperCase()).includes("NX") && strings.has(key)) return null;
    strings.set(key, value);
    return "OK";
  }
  if (name === "DEL") return strings.delete(args[0]) ? 1 : 0;
  if (name === "EXPIRE") return 1;
  if (name === "LPUSH") {
    const target = lists.get(args[0]) || [];
    target.unshift(...args.slice(1));
    lists.set(args[0], target);
    return target.length;
  }
  if (name === "LTRIM") {
    const target = lists.get(args[0]) || [];
    lists.set(args[0], target.slice(Number(args[1]), Number(args[2]) + 1));
    return "OK";
  }
  if (name === "LRANGE") {
    const target = lists.get(args[0]) || [];
    return target.slice(Number(args[1]), Number(args[2]) < 0 ? undefined : Number(args[2]) + 1);
  }
  if (name === "ZADD") {
    sortedSet(args[0]).set(args[2], Number(args[1]));
    return 1;
  }
  if (name === "ZSCORE") return sortedSet(args[0]).has(args[1]) ? String(sortedSet(args[0]).get(args[1])) : null;
  if (name === "ZREM") return sortedSet(args[0]).delete(args[1]) ? 1 : 0;
  if (name === "ZRANGE") {
    return [...sortedSet(args[0]).entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(Number(args[1]), Number(args[2]) < 0 ? undefined : Number(args[2]) + 1)
      .map(([member]) => member);
  }
  if (name === "ZRANGEBYSCORE") {
    const min = args[1] === "-inf" ? -Infinity : Number(args[1]);
    const max = args[2] === "+inf" ? Infinity : Number(args[2]);
    let rows = [...sortedSet(args[0]).entries()].sort((a, b) => a[1] - b[1]).filter(([, score]) => score >= min && score <= max);
    const limitIndex = args.findIndex((item) => String(item).toUpperCase() === "LIMIT");
    if (limitIndex >= 0) rows = rows.slice(Number(args[limitIndex + 1]), Number(args[limitIndex + 1]) + Number(args[limitIndex + 2]));
    return rows.map(([member]) => member);
  }
  if (name === "EVAL") {
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (script.includes("hasRecord=raw~=false") && script.includes("duplicate=duplicate")) {
      const raw = strings.get(keys[0]);
      return JSON.stringify({ ok: true, hasRecord: raw != null, record: raw || "", duplicate: strings.has(keys[1]) });
    }
    if (script.includes("local current=redis.call('GET',KEYS[1])") && script.includes("LPUSH")) {
      const raw = strings.get(keys[0]);
      if (argv[2] === "0" ? raw != null : raw == null || raw !== argv[3]) return "__conflict__";
      const encoded = String(argv[0]);
      strings.set(keys[0], encoded);
      const target = lists.get(keys[1]) || [];
      target.unshift(encoded);
      lists.set(keys[1], target.slice(0, Number(argv[1])));
      return encoded;
    }
    if (script.includes("state='duplicate'") && script.includes("state='acquired'")) {
      if (strings.has(keys[0])) return JSON.stringify({ ok: true, state: "duplicate" });
      if (strings.has(keys[1])) return JSON.stringify({ ok: true, state: "locked" });
      strings.set(keys[1], argv[0]);
      return JSON.stringify({ ok: true, state: "acquired" });
    }
    if (script.includes("state='locked'") && script.includes("state='acquired'")) {
      if (strings.has(keys[0])) return JSON.stringify({ ok: true, state: "locked" });
      strings.set(keys[0], argv[0]);
      return JSON.stringify({ ok: true, state: "acquired" });
    }
    if (script.includes("ARGV[3]") && script.includes("ZADD") && script.includes("ARGV[4]")) {
      strings.set(keys[0], argv[0]);
      sortedSet(keys[1]).set(argv[3], Number(argv[1]));
      return 1;
    }
    if (script.includes("redis.call('DEL',KEYS[1])") && script.includes("redis.call('ZREM',KEYS[2]")) {
      strings.delete(keys[0]);
      sortedSet(keys[1]).delete(argv[0]);
      return 1;
    }
    if (script.includes("redis.call('GET',KEYS[1])==ARGV[1]")) {
      if (strings.get(keys[0]) !== argv[0]) return 0;
      strings.delete(keys[0]);
      return 1;
    }
    throw new Error(`unexpected EVAL: ${script.slice(0, 80)}`);
  }
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin === "http://telegram-retry.redis.test") {
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(options.body || "[]");
      if (failExactInvalidCleanupOnce && commands[0]?.[0] === "ZREM" && commands[0]?.[1] === "lm:ops:telegram:retry:v1") {
        failExactInvalidCleanupOnce = false;
        return Response.json([{ error: "injected exact cleanup failure" }, { result: "PONG" }]);
      }
      if (failRetryRecoveryPipelineOnce && commands.length === 3 && commands[0]?.[0] === "GET" && commands[1]?.[0] === "ZSCORE") {
        failRetryRecoveryPipelineOnce = false;
        return Response.json([{ error: "injected recovery read failure" }, ...commands.slice(1).map((command) => ({ result: execute(command) }))]);
      }
      return Response.json(commands.map((command) => ({ result: execute(command) })));
    }
    const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const result = execute(command);
    if (loseRetryUpsertResponse && String(command[0]).toUpperCase() === "EVAL"
        && String(command[1]).includes("telegram_invalid_retry_record")) {
      loseRetryUpsertResponse = false;
      return Response.json({ result: null });
    }
    return Response.json({ result });
  }
  if (url.origin === "https://api.telegram.org") {
    telegramBodies.push(JSON.parse(options.body || "{}"));
    const next = telegramResponses.shift() || { status: 200, payload: { ok: true, result: { message_id: 1 } } };
    return Response.json(next.payload, { status: next.status });
  }
  return originalFetch(input, options);
};

const telegram = await import("../app/api/_telegram-alerts.js");

test.after(() => { globalThis.fetch = originalFetch; });

function reset() {
  strings.clear();
  lists.clear();
  sortedSets.clear();
  telegramResponses.length = 0;
  telegramBodies.length = 0;
  loseRetryUpsertResponse = false;
  failRetryRecoveryPipelineOnce = false;
  failExactInvalidCleanupOnce = false;
}

test("health incident Telegram is opt-in without disabling other operational alerts", async () => {
  reset();
  const previous = process.env.OPS_INCIDENT_TELEGRAM_ENABLED;
  try {
    delete process.env.OPS_INCIDENT_TELEGRAM_ENABLED;
    const incident = {
      id: "INC-HEALTH-SILENT",
      fingerprint: "health:cron:maintenance",
      severity: "P1",
      title: "maintenance cron missed",
      component: "cron",
    };
    const opened = await telegram.notifyIncidentOpened(incident, { reopened: false });
    const reopened = await telegram.notifyIncidentOpened(incident, { reopened: true });
    const recovered = await telegram.notifyIncidentRecovered(incident);
    for (const result of [opened, reopened, recovered]) {
      assert.deepEqual(result, {
        ok: true,
        skipped: true,
        reason: "incident_telegram_disabled",
      });
    }
    assert.equal(telegramBodies.length, 0);

    const securityAlert = await telegram.sendOperationalTelegram({
      fingerprint: "security:admin-login:unexpected-origin",
      incidentId: "",
      event: "security_alert",
      text: "security notification remains enabled",
    });
    assert.equal(securityAlert.ok, true);
    assert.equal(telegramBodies.length, 1);

    reset();
    process.env.OPS_INCIDENT_TELEGRAM_ENABLED = "1";
    const enabled = await telegram.notifyIncidentOpened({
      ...incident,
      id: "INC-HEALTH-OPT-IN",
      fingerprint: "health:cron:maintenance:opt-in",
    }, { reopened: false });
    assert.equal(enabled.ok, true);
    assert.notEqual(enabled.skipped, true);
    assert.equal(telegramBodies.length, 1);
  } finally {
    if (previous == null) delete process.env.OPS_INCIDENT_TELEGRAM_ENABLED;
    else process.env.OPS_INCIDENT_TELEGRAM_ENABLED = previous;
  }
});

test("maintenance workflow has no independent system-health Telegram sender", () => {
  const workflow = readFileSync(new URL("../.github/workflows/maintenance-cron.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /TELEGRAM_(?:BOT_TOKEN|CHAT_ID)|api\.telegram\.org|Telegram failure alert/);
  assert.doesNotMatch(workflow, /--retry(?:-all-errors|-delay)?\b/);
});

test("history and retry readers skip isolated corrupt rows without hiding healthy object rows", async () => {
  reset();
  lists.set("lm:ops:telegram:history:v1", [
    JSON.stringify({ id: "history-string", status: "sent" }),
    "{not-json",
    [],
    {},
    { id: "history-status-missing" },
    { id: "history-object", status: "failed" },
  ]);
  sortedSet("lm:ops:telegram:retry:v1").set("healthy-object", 1);
  sortedSet("lm:ops:telegram:retry:v1").set("broken-json", 2);
  sortedSet("lm:ops:telegram:retry:v1").set("missing-row", 3);
  sortedSet("lm:ops:telegram:retry:v1").set("mismatched-row", 4);
  sortedSet("lm:ops:telegram:retry:v1").set("empty-row", 5);
  strings.set("lm:ops:telegram:retry-record:v1:healthy-object", {
    hash: "healthy-object", message: "safe", nextAttemptAt: Date.now() + 60_000,
  });
  strings.set("lm:ops:telegram:retry-record:v1:broken-json", "{not-json");
  strings.set("lm:ops:telegram:retry-record:v1:mismatched-row", {
    hash: "another-hash", message: "safe", nextAttemptAt: Date.now() + 60_000,
  });
  strings.set("lm:ops:telegram:retry-record:v1:empty-row", {});

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const history = await telegram.readTelegramAlertHistory();
    assert.deepEqual(history.map((record) => record.id), ["history-string", "history-object"]);
    const retry = await telegram.readTelegramRetryQueue();
    assert.deepEqual(retry.map((record) => record.hash), ["healthy-object"]);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.some((entry) => entry[1]?.skipped === 4), true);
});

test("retry queue pages past a full corrupt display window", async () => {
  reset();
  const index = sortedSet("lm:ops:telegram:retry:v1");
  for (let item = 0; item < 105; item += 1) {
    const hash = `corrupt-${String(item).padStart(3, "0")}`;
    index.set(hash, item);
    strings.set(`lm:ops:telegram:retry-record:v1:${hash}`, {});
  }
  index.set("valid-after-window", 105);
  strings.set("lm:ops:telegram:retry-record:v1:valid-after-window", {
    hash: "valid-after-window",
    message: "deliver me",
    nextAttemptAt: Date.now() + 60_000,
  });
  const records = await telegram.readTelegramRetryQueue(1);
  assert.deepEqual(records.map((record) => record.hash), ["valid-after-window"]);
});

test("Telegram history reads past corrupt rows that fill the requested window", async () => {
  reset();
  lists.set("lm:ops:telegram:history:v1", [
    "{not-json",
    {},
    JSON.stringify({ id: "history-after-window", status: "sent" }),
  ]);
  const history = await telegram.readTelegramAlertHistory(1);
  assert.deepEqual(history.map((record) => record.id), ["history-after-window"]);
});

test("a committed provider marker with a lost Redis response still sends exactly once", async () => {
  reset();
  loseRetryUpsertResponse = true;
  failRetryRecoveryPipelineOnce = true;
  assert.equal(telegramBodies.length, 0);
  const sent = await telegram.sendOperationalTelegram({
    fingerprint: "incident:marker-response-loss",
    incidentId: "INC-MARKER-LOSS",
    event: "opened",
    text: "marker response lost after commit",
  });
  assert.equal(sent.ok, true);
  assert.equal(loseRetryUpsertResponse, false);
  assert.equal(telegramBodies.length, 1);
  assert.equal((await telegram.readTelegramRetryQueue()).length, 0);
});

test("a generic 5xx operational alert is persisted and maintenance retries it exactly once", async () => {
  reset();
  telegramResponses.push(
    { status: 503, payload: { ok: false, description: "temporary" } },
    { status: 200, payload: { ok: true, result: { message_id: 42 } } },
  );
  const first = await telegram.sendOperationalTelegram({
    fingerprint: "incident:telegram-retry",
    incidentId: "",
    event: "opened",
    text: "buyer@example.com token=123456:telegram-secret-token 发生故障",
  });
  assert.equal(first.ok, false);
  assert.equal(first.retryable, true);
  assert.equal(first.retryQueued, true);
  const queued = await telegram.readTelegramRetryQueue();
  assert.equal(queued.length, 1);
  assert.match(queued[0].message, /b\*\*\*@example\.com/);
  assert.doesNotMatch(queued[0].message, /telegram-secret-token/);

  const drained = await telegram.drainTelegramAlertRetries({ now: queued[0].nextAttemptAt });
  assert.equal(drained.ok, true);
  assert.equal(drained.sent, 1);
  assert.equal((await telegram.readTelegramRetryQueue()).length, 0);
  assert.equal(telegramBodies.length, 2);

  const replay = await telegram.sendOperationalTelegram({
    fingerprint: "incident:telegram-retry",
    incidentId: "",
    event: "opened",
    text: "同一事故",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(telegramBodies.length, 2);
});

test("maintenance retires pre-deployment incident retries while health Telegram is disabled", async () => {
  reset();
  const previous = process.env.OPS_INCIDENT_TELEGRAM_ENABLED;
  try {
    process.env.OPS_INCIDENT_TELEGRAM_ENABLED = "1";
    telegramResponses.push({ status: 503, payload: { ok: false, description: "temporary" } });
    const first = await telegram.sendOperationalTelegram({
      fingerprint: "incident:legacy-health-retry",
      incidentId: "INC-LEGACY-HEALTH",
      event: "reopened:4",
      text: "legacy system incident retry",
    });
    assert.equal(first.retryQueued, true);
    const [queued] = await telegram.readTelegramRetryQueue();
    assert.ok(queued);
    assert.equal(telegramBodies.length, 1);

    process.env.OPS_INCIDENT_TELEGRAM_ENABLED = "0";
    const drained = await telegram.drainTelegramAlertRetries({ now: queued.nextAttemptAt });
    assert.equal(drained.ok, true);
    assert.equal(drained.sent, 0);
    assert.equal(drained.terminal, 1);
    assert.equal((await telegram.readTelegramRetryQueue()).length, 0);
    assert.equal(telegramBodies.length, 1, "disabled incident retry must not call Telegram again");
  } finally {
    if (previous == null) delete process.env.OPS_INCIDENT_TELEGRAM_ENABLED;
    else process.env.OPS_INCIDENT_TELEGRAM_ENABLED = previous;
  }
});

test("retry drain removes 100 overlong raw members exactly and still reaches the valid task", async () => {
  reset();
  telegramResponses.push(
    { status: 503, payload: { ok: false, description: "temporary" } },
    { status: 200, payload: { ok: true, result: { message_id: 43 } } },
  );
  const first = await telegram.sendOperationalTelegram({
    fingerprint: "incident:retry-invalid-index-prefix",
    incidentId: "",
    event: "opened",
    text: "valid task after corrupt index members",
  });
  assert.equal(first.retryQueued, true);
  const [queued] = await telegram.readTelegramRetryQueue();
  assert.ok(queued);

  const index = sortedSet(telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX);
  const protectedHash = "0".repeat(64);
  const protectedNextAttemptAt = queued.nextAttemptAt + 60_000;
  index.set(protectedHash, protectedNextAttemptAt);
  strings.set(telegram.telegramAlertInternals.retryRecordKey(protectedHash), JSON.stringify({
    hash: protectedHash,
    message: "future task whose hash is an invalid member prefix",
    nextAttemptAt: protectedNextAttemptAt,
    attempts: 0,
    createdAtMs: queued.createdAtMs,
    providerDelivered: false,
  }));
  const corruptMembers = Array.from({ length: 100 }, (_, item) => `${item.toString(16).padStart(64, "0")}f`);
  corruptMembers.forEach((member, item) => index.set(member, queued.nextAttemptAt - 1_000 + item));

  const drained = await telegram.drainTelegramAlertRetries({ now: queued.nextAttemptAt, limit: 1 });
  assert.equal(drained.ok, true, JSON.stringify(drained));
  assert.equal(drained.scanned, 101);
  assert.equal(drained.processed, 1);
  assert.equal(drained.sent, 1);
  assert.equal(telegramBodies.length, 2);
  assert.equal(telegramBodies.some((body) => body.text?.includes("future task whose hash")), false);
  assert.equal(corruptMembers.every((member) => !index.has(member)), true);
  assert.equal(index.has(protectedHash), true, "cleanup must not truncate a bad member and delete its 64-character prefix");
  assert.equal(strings.has(telegram.telegramAlertInternals.retryRecordKey(protectedHash)), true);
});

test("an exact invalid-member cleanup command error keeps the drain unhealthy", async () => {
  reset();
  telegramResponses.push(
    { status: 503, payload: { ok: false, description: "temporary" } },
    { status: 200, payload: { ok: true, result: { message_id: 44 } } },
  );
  await telegram.sendOperationalTelegram({
    fingerprint: "incident:retry-cleanup-command-error",
    event: "opened",
    text: "valid task after cleanup command error",
  });
  const [queued] = await telegram.readTelegramRetryQueue();
  const invalidMember = `${"f".repeat(64)}0`;
  sortedSet(telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX).set(invalidMember, queued.nextAttemptAt - 1);
  failExactInvalidCleanupOnce = true;

  const drained = await telegram.drainTelegramAlertRetries({ now: queued.nextAttemptAt, limit: 1 });
  assert.equal(drained.ok, false);
  assert.equal(drained.error, "telegram_retry_processing_failed");
  assert.equal(drained.failed, 1);
  assert.equal(drained.sent, 1);
  assert.equal(sortedSet(telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX).has(invalidMember), true);
});

test("429 respects Retry-After while 400 is terminal configuration failure", async () => {
  reset();
  const before = Date.now();
  telegramResponses.push({ status: 429, payload: { ok: false, parameters: { retry_after: 180 } } });
  const limited = await telegram.sendOperationalTelegram({ fingerprint: "incident:rate-limit", event: "opened", text: "rate limited" });
  assert.equal(limited.retryQueued, true);
  const [record] = await telegram.readTelegramRetryQueue();
  assert.ok(record.nextAttemptAt >= before + 180_000);

  telegramResponses.push({ status: 400, payload: { ok: false, description: "bad chat" } });
  const terminal = await telegram.sendOperationalTelegram({ fingerprint: "incident:bad-config", event: "opened", text: "bad config" });
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.configurationError, true);
  assert.equal((await telegram.readTelegramRetryQueue()).length, 1, "only the earlier 429 remains queued");
});

test("expired or max-attempt alerts are removed without another provider call", async () => {
  reset();
  telegramResponses.push({ status: 500, payload: { ok: false } });
  await telegram.sendOperationalTelegram({ fingerprint: "incident:expires", event: "opened", text: "expires" });
  const [record] = await telegram.readTelegramRetryQueue();
  record.attempts = telegram.telegramAlertInternals.RETRY_MAX_ATTEMPTS;
  record.nextAttemptAt = Date.now() - 1;
  strings.set(telegram.telegramAlertInternals.retryRecordKey(record.hash), JSON.stringify(record));
  sortedSet(telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX).set(record.hash, record.nextAttemptAt);
  const callsBefore = telegramBodies.length;
  const drained = await telegram.drainTelegramAlertRetries({ now: Date.now() });
  assert.equal(drained.terminal, 1);
  assert.equal(telegramBodies.length, callsBefore);
  assert.equal((await telegram.readTelegramRetryQueue()).length, 0);
});

test("an in-flight provider marker is quarantined without a duplicate Telegram send", async () => {
  reset();
  telegramResponses.push({ status: 503, payload: { ok: false } });
  await telegram.sendOperationalTelegram({ fingerprint: "incident:uncertain-crash", event: "opened", text: "uncertain" });
  const [record] = await telegram.readTelegramRetryQueue();
  record.providerAttemptedAt = new Date().toISOString();
  record.providerDelivered = false;
  record.nextAttemptAt = Date.now();
  strings.set(telegram.telegramAlertInternals.retryRecordKey(record.hash), JSON.stringify(record));
  sortedSet(telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX).set(record.hash, record.nextAttemptAt);
  const callsBefore = telegramBodies.length;
  const drained = await telegram.drainTelegramAlertRetries({ now: Date.now() });
  assert.equal(drained.terminal, 1);
  assert.equal(telegramBodies.length, callsBefore);
  assert.equal((await telegram.readTelegramRetryQueue()).length, 0);
});

test("provider classification never retries configuration errors", () => {
  for (const status of [400, 401, 403]) {
    const result = telegram.telegramAlertInternals.providerFailure(status, {});
    assert.equal(result.terminal, true);
    assert.equal(result.configurationError, true);
    assert.equal(Boolean(result.retryable), false);
  }
  assert.equal(telegram.telegramAlertInternals.providerFailure(503, {}).retryable, true);
});
