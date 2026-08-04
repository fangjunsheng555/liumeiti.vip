import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.KV_REST_API_URL = "http://lua-delivery-telegram.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
process.env.TELEGRAM_CHAT_ID = "987654";

const delivery = await import("../app/api/_delivery-once.js");
const telegram = await import("../app/api/_telegram-alerts.js");
const timeline = await import("../app/api/_order-timeline.js");
const money = await import("../app/api/_money.js");
const usdt = await import("../app/api/_usdt-confirm.js");
const incidents = await import("../app/api/_incidents.js");
const { redisCmd } = await import("../app/api/_utils.js");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function scriptFrom(relativeFile, name) {
  const source = readFileSync(new URL(relativeFile, import.meta.url), "utf8");
  const match = source.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"));
  assert.ok(match, `${name} must remain discoverable`);
  return match[1];
}

function realRedis(container) {
  const run = (command) => {
    const child = docker(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis-cli failed");
    const output = child.stdout.trim();
    if (/^error:/i.test(output)) throw new Error(output);
    return output ? JSON.parse(output) : null;
  };
  return {
    run,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      try {
        if (url.pathname === "/pipeline") {
          const commands = JSON.parse(String(init.body || "[]"));
          return Response.json(commands.map((command) => {
            try { return { result: run(command) }; } catch (error) { return { error: error.message }; }
          }));
        }
        return Response.json({ result: run(url.pathname.split("/").slice(1).map(decodeURIComponent)) });
      } catch (error) {
        return Response.json({ error: error.message }, { status: 400 });
      }
    },
  };
}

test("delivery, Telegram, USDT effect and timeline scripts preflight every write in real Redis", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-delivery-telegram-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const originalFetch = globalThis.fetch;
  let telegramCalls = 0;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Redis container did not become ready");
    const redis = realRedis(container);
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).origin === "https://api.telegram.org") {
        telegramCalls += 1;
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      return redis.fetch(input, init);
    };

    // Probe 1: the last delivery index is WRONGTYPE. The claim must not create
    // a journal or call the provider before discovering it.
    redis.run(["FLUSHDB"]);
    redis.run(["SET", delivery.deliveryInternals.DELIVERY_RETRYABLE_INDEX, "wrong-type"]);
    let delivered = 0;
    const claimFailed = await delivery.deliverOnce("probe:claim-preflight", async () => { delivered += 1; return true; });
    const claimKey = delivery.deliveryInternals.deliveryKey("probe:claim-preflight");
    assert.equal(claimFailed.error, "delivery_journal_unavailable");
    assert.equal(delivered, 0);
    assert.equal(redis.run(["EXISTS", claimKey]), 0);
    assert.equal(redis.run(["GET", delivery.deliveryInternals.DELIVERY_RETRYABLE_INDEX]), "wrong-type");

    // Probe 2: corrupt the last index after acquisition. TRANSITION must leave
    // the exact sending journal untouched instead of SET-then-failing at ZADD.
    redis.run(["FLUSHDB"]);
    let transitionRaw = "";
    const transitionFailed = await delivery.deliverOnce("probe:transition-preflight", async () => {
      const key = delivery.deliveryInternals.deliveryKey("probe:transition-preflight");
      transitionRaw = redis.run(["GET", key]);
      redis.run(["SET", delivery.deliveryInternals.DELIVERY_RETRYABLE_INDEX, "wrong-type"]);
      return false;
    });
    const transitionKey = delivery.deliveryInternals.deliveryKey("probe:transition-preflight");
    assert.equal(transitionFailed.uncertain, true);
    assert.equal(redis.run(["GET", transitionKey]), transitionRaw);

    // Probe 3: the same late WRONGTYPE during completion must not replace the
    // sending journal with a false done record.
    redis.run(["FLUSHDB"]);
    let completionRaw = "";
    const completionFailed = await delivery.deliverOnce("probe:completion-preflight", async () => {
      const key = delivery.deliveryInternals.deliveryKey("probe:completion-preflight");
      completionRaw = redis.run(["GET", key]);
      redis.run(["SET", delivery.deliveryInternals.DELIVERY_UNCERTAIN_INDEX, "wrong-type"]);
      return { ok: true };
    });
    const completionKey = delivery.deliveryInternals.deliveryKey("probe:completion-preflight");
    assert.equal(completionFailed.uncertain, true);
    assert.equal(redis.run(["GET", completionKey]), completionRaw);

    // Probe 4: a legacy done-shaped record without a successful result is
    // read-only and uncertain; it must never invent a successful replay.
    redis.run(["FLUSHDB"]);
    const legacyId = "probe:legacy-json";
    const legacyKey = delivery.deliveryInternals.deliveryKey(legacyId);
    const legacyRaw = "{\"status\":\"done\",\"token\":\"legacy\",\"score\":1,\"legacyRows\":[],\"legacyNull\":null,\"legacyHuge\":123456789012345678901234567890}";
    redis.run(["SET", legacyKey, legacyRaw]);
    const legacyReplay = await delivery.deliverOnce(legacyId, async () => { throw new Error("must not deliver"); });
    assert.equal(legacyReplay.ok, false);
    assert.equal(legacyReplay.uncertain, true);
    assert.equal(legacyReplay.error, "delivery_result_uncertain");
    assert.equal(redis.run(["GET", legacyKey]), legacyRaw);

    // Probe 5: the real Redis claim serializes concurrent callers; only one
    // provider callback can cross the journal boundary.
    redis.run(["FLUSHDB"]);
    let release;
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let concurrentCalls = 0;
    const first = delivery.deliverOnce("probe:concurrent", async () => {
      concurrentCalls += 1;
      entered();
      await gate;
      return true;
    });
    await enteredPromise;
    const second = await delivery.deliverOnce("probe:concurrent", async () => { concurrentCalls += 1; return true; });
    assert.equal(second.pending, true);
    release();
    assert.equal((await first).ok, true);
    assert.equal(concurrentCalls, 1);

    // Probe 6: UPSERT_RETRY sees a WRONGTYPE index before writing the record,
    // and therefore never calls Telegram with an unjournaled outcome.
    redis.run(["FLUSHDB"]);
    redis.run(["SET", telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX, "wrong-type"]);
    telegramCalls = 0;
    const alert = await telegram.sendOperationalTelegram({
      fingerprint: "probe:telegram-upsert",
      incidentId: "INC-PREFLIGHT",
      event: "opened",
      text: "preflight",
    });
    const alertHash = telegram.telegramAlertInternals.alertFingerprint("probe:telegram-upsert\0INC-PREFLIGHT\0opened");
    assert.equal(alert.error, "telegram_attempt_journal_unavailable");
    assert.equal(telegramCalls, 0);
    assert.equal(redis.run(["EXISTS", telegram.telegramAlertInternals.retryRecordKey(alertHash)]), 0);

    // Probe 7: a pre-hardening retry row with a fractional attempt count and
    // null creation time is normalized on the next write instead of becoming
    // a permanent poison record.
    redis.run(["FLUSHDB"]);
    const legacyAlertHash = "c".repeat(64);
    const legacyRetryKey = telegram.telegramAlertInternals.retryRecordKey(legacyAlertHash);
    redis.run(["SET", legacyRetryKey, JSON.stringify({
      hash: legacyAlertHash,
      fingerprint: "legacy-retry",
      incidentId: "INC-LEGACY",
      event: "opened",
      message: "legacy alert",
      attempts: 1.5,
      createdAtMs: null,
      nextAttemptAt: 1,
    })]);
    redis.run(["ZADD", telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX, "1", legacyAlertHash]);
    telegramCalls = 0;
    const legacyDrain = await telegram.drainTelegramAlertRetries({ now: Date.now() });
    assert.equal(legacyDrain.processed, 1);
    assert.equal(legacyDrain.sent, 1);
    assert.equal(telegramCalls, 1);
    assert.equal(redis.run(["EXISTS", legacyRetryKey]), 0);

    const upsertScript = scriptFrom("../app/api/_telegram-alerts.js", "UPSERT_RETRY_SCRIPT");
    const removeScript = scriptFrom("../app/api/_telegram-alerts.js", "REMOVE_RETRY_SCRIPT");
    const timelineScript = scriptFrom("../app/api/_order-timeline.js", "APPEND_ONCE_SCRIPT");
    const completeEffectScript = scriptFrom("../app/api/_usdt-confirm.js", "COMPLETE_EFFECT_SCRIPT");

    // Probe 8: valid retry JSON is stored as the original token stream. Bad
    // scores, fractional TTLs, null, and arrays fail before either key changes.
    redis.run(["FLUSHDB"]);
    const retryHash = "a".repeat(64);
    const retryKey = telegram.telegramAlertInternals.retryRecordKey(retryHash);
    const retryRaw = `{\"hash\":\"${retryHash}\",\"message\":\"legacy alert\",\"providerDelivered\":false,\"attempts\":1,\"createdAtMs\":1,\"nextAttemptAt\":12345,\"legacyRows\":[],\"legacyNull\":null,\"legacyHuge\":123456789012345678901234567890}`;
    assert.equal(await redisCmd(["EVAL", upsertScript, "2", retryKey, telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX, retryRaw, "12345", "60", retryHash]), 1);
    assert.equal(redis.run(["GET", retryKey]), retryRaw);
    for (const [raw, score, ttl, hash] of [
      [retryRaw, "NaN", "60", retryHash],
      [retryRaw, "12345", "1.5", retryHash],
      ["null", "12345", "60", retryHash],
      ["[]", "12345", "60", retryHash],
      [retryRaw.replace('\"attempts\":1', '\"attempts\":1.5'), "12345", "60", retryHash],
      [retryRaw, "12345", "60", ""],
    ]) {
      redis.run(["FLUSHDB"]);
      assert.equal(await redisCmd(["EVAL", upsertScript, "2", retryKey, telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX, raw, score, ttl, hash]), null);
      assert.equal(redis.run(["DBSIZE"]), 0);
    }

    // Probe 9: REMOVE_RETRY must not HDEL/DEL its record before discovering a
    // wrong-type final index.
    redis.run(["FLUSHDB"]);
    redis.run(["SET", retryKey, retryRaw]);
    redis.run(["SET", telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX, "wrong-type"]);
    assert.equal(await redisCmd(["EVAL", removeScript, "2", retryKey, telegram.telegramAlertInternals.TELEGRAM_RETRY_INDEX, retryHash]), null);
    assert.equal(redis.run(["GET", retryKey]), retryRaw);

    // Probe 10: COMPLETE_EFFECT checks the final ZSET before HDEL. The effect
    // retains every legacy JSON token when that index is corrupt.
    redis.run(["FLUSHDB"]);
    const effectHash = "lm:test:effects";
    const effectIndex = "lm:test:effects:index";
    const effectKey = "b".repeat(64);
    const effectRaw = "{\"legacyRows\":[],\"legacyNull\":null,\"legacyHuge\":123456789012345678901234567890}";
    redis.run(["HSET", effectHash, effectKey, effectRaw]);
    redis.run(["SET", effectIndex, "wrong-type"]);
    assert.equal(await redisCmd(["EVAL", completeEffectScript, "2", effectHash, effectIndex, effectKey, effectRaw]), null);
    assert.equal(redis.run(["HGET", effectHash, effectKey]), effectRaw);
    assert.equal(redis.run(["GET", effectIndex]), "wrong-type");

    // Probe 11: exercise the complete production USDT dispatch chain, not
    // only the script boundary. Completed delivery side effects cannot make a
    // corrupt final index erase the original outbox record.
    redis.run(["FLUSHDB"]);
    const orderId = "LM-USDT-PREFLIGHT";
    const txId = "tx-usdt-preflight";
    const productionEffectKey = money.usdtConfirmationEffectKey(orderId, txId);
    const productionEffect = {
      version: 1,
      effectKey: productionEffectKey,
      orderId,
      txId,
      amount: 12.34,
      amountMicros: "12340000",
      email: "guest@example.com",
      userEmail: "",
      accountLifecycleId: "",
      locale: "zh",
      businessTraceId: "BT-USDT-PREFLIGHT",
      actor: { staffId: 1, staffUsername: "system" },
    };
    const productionRaw = JSON.stringify(productionEffect).replace(/}$/, ",\"legacyRows\":[],\"legacyNull\":null,\"legacyHuge\":123456789012345678901234567890}");
    redis.run(["HSET", money.USDT_CONFIRM_EFFECT_RECORDS_KEY, productionEffectKey, productionRaw]);
    redis.run(["SET", money.USDT_CONFIRM_EFFECT_INDEX_KEY, "wrong-type"]);
    telegramCalls = 0;
    const dispatched = await usdt.dispatchUsdtConfirmationEffect(productionEffectKey, {
      notify: { telegramEnabled: false },
    });
    assert.equal(dispatched.ok, false);
    assert.equal(dispatched.settled, false);
    assert.equal(dispatched.error, "confirmation_effect_finalize_failed");
    assert.equal(telegramCalls, 0);
    assert.equal(redis.run(["HGET", money.USDT_CONFIRM_EFFECT_RECORDS_KEY, productionEffectKey]), productionRaw);
    assert.equal(redis.run(["GET", money.USDT_CONFIRM_EFFECT_INDEX_KEY]), "wrong-type");

    // Probe 12: APPEND_ONCE validates list type, event shape, and limit before
    // setting the permanent marker; valid legacy tokens are pushed verbatim.
    redis.run(["FLUSHDB"]);
    const marker = "lm:test:timeline:once";
    const list = "lm:test:timeline";
    redis.run(["SET", list, "wrong-type"]);
    const eventRaw = "{\"id\":\"event-1\",\"type\":\"updated\",\"createdAt\":\"2026-08-04T00:00:00.000Z\",\"legacyRows\":[],\"legacyNull\":null,\"legacyHuge\":123456789012345678901234567890}";
    assert.equal(await redisCmd(["EVAL", timelineScript, "2", marker, list, eventRaw, "100"]), -2);
    assert.equal(redis.run(["EXISTS", marker]), 0);
    redis.run(["DEL", list]);
    for (const [raw, limit] of [["null", "100"], ["[]", "100"], [eventRaw, "1.5"], [eventRaw, "NaN"], [eventRaw, "0"]]) {
      assert.equal(await redisCmd(["EVAL", timelineScript, "2", marker, list, raw, limit]), -2);
      assert.equal(redis.run(["EXISTS", marker]), 0);
      assert.equal(redis.run(["EXISTS", list]), 0);
    }
    assert.equal(await redisCmd(["EVAL", timelineScript, "2", marker, list, eventRaw, "100"]), 1);
    assert.equal(redis.run(["LINDEX", list, "0"]), eventRaw);

    // Keep one public timeline assertion in the same real REST path.
    assert.equal(await timeline.appendOrderTimelineOnce("LM-REAL-1", "probe:timeline-public", { type: "updated" }), true);

    // Probe 13: CREATE commits in real Redis but its REST response is lost.
    // Recovery may report created only after matching the mapping, exact record,
    // index score, first event and a live PING through the production read path.
    redis.run(["FLUSHDB"]);
    const workingFetch = globalThis.fetch;
    let droppedIncidentCreate = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
      if (!droppedIncidentCreate && command[0] === "EVAL"
          && String(command[1] || "").includes("incident_id_conflict")
          && String(command[1] || "").includes("fingerprint_conflict")) {
        const committed = await workingFetch(input, init);
        assert.equal(committed.ok, true);
        droppedIncidentCreate = true;
        return Response.json({ result: null });
      }
      return workingFetch(input, init);
    };
    try {
      const recoveredIncident = await incidents.openOrUpdateIncident({
        fingerprint: "probe:real-redis-create-response-loss",
        component: "redis",
        title: "real Redis response loss",
      });
      assert.equal(droppedIncidentCreate, true);
      assert.equal(recoveredIncident.ok, true);
      assert.equal(recoveredIncident.created, true);
      assert.equal(recoveredIncident.recovered, true);
      assert.equal((await incidents.getIncident(recoveredIncident.record.id)).id, recoveredIncident.record.id);
      assert.equal((await incidents.incidentEvents(recoveredIncident.record.id))[0].type, "opened");
    } finally {
      globalThis.fetch = workingFetch;
    }
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
