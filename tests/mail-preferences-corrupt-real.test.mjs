import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.AUTH_SECRET = "mail-corrupt-real-secret-32-characters";
process.env.MAIL_PREFERENCES_SECRET = process.env.AUTH_SECRET;
process.env.KV_REST_API_URL = "http://mail-corrupt-real.redis.test";
process.env.KV_REST_API_TOKEN = "mail-corrupt-real-token";

const preferences = await import("../app/api/_mail-preferences.js");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
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
      if (url.pathname === "/pipeline") {
        const commands = JSON.parse(String(init.body || "[]"));
        return Response.json(commands.map((command) => {
          try { return { result: run(command) }; }
          catch (error) { return { error: String(error?.message || error) }; }
        }));
      }
      return Response.json({ result: run(url.pathname.split("/").slice(1).map(decodeURIComponent)) });
    },
  };
}

test("real Redis repairs corrupt mail contacts without ever reopening delivery", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async (t) => {
  const container = `lm-mail-corrupt-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const originalFetch = globalThis.fetch;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "Redis container did not become ready");
    const redis = realRedis(container);
    globalThis.fetch = redis.fetch;

    await t.test("malformed, empty, and wrong-identity rows block marketing without locking critical mail", async () => {
      const shapes = [
        ["mime-broken@example.com", "{broken"],
        ["mime-empty@example.com", ""],
        ["mime-wrong-id@example.com", JSON.stringify({ contactId: "f".repeat(40), email: "other@example.com", revision: 3 })],
      ];
      for (const [email, raw] of shapes) {
        const contactId = preferences.mailContactId(email);
        const key = preferences.mailPreferenceInternals.contactKey(contactId);
        redis.run(["SET", key, raw]);
        const decisions = await Promise.all([
          preferences.getMailSendDecision({ email, purpose: "critical", category: "security" }),
          preferences.getMailSendDecision({ email, purpose: "transactional", category: "order" }),
          preferences.getMailSendDecision({ email, purpose: "marketing", category: "marketing" }),
        ]);
        assert.deepEqual(decisions.map((decision) => decision.allowed), [true, true, false]);
        const stored = JSON.parse(redis.run(["GET", key]));
        assert.equal(stored.contactId, contactId);
        assert.equal(stored.suppression.scope, "marketing");
        assert.equal(redis.run(["SISMEMBER", "lm:mail:suppressed:all", contactId]), 0);
        assert.equal(redis.run(["SISMEMBER", "lm:mail:suppressed:marketing", contactId]), 1);
        assert.equal(redis.run(["SISMEMBER", "lm:mail:suppressed:optional", contactId]), 0);
      }

      const wrongTypeEmail = "mime-wrong-type@example.com";
      const wrongTypeId = preferences.mailContactId(wrongTypeEmail);
      const wrongTypeKey = preferences.mailPreferenceInternals.contactKey(wrongTypeId);
      redis.run(["HSET", wrongTypeKey, "legacy", "wrong-type"]);
      const wrongTypeDecisions = await Promise.all([
        preferences.getMailSendDecision({ email: wrongTypeEmail, purpose: "critical", category: "security" }),
        preferences.getMailSendDecision({ email: wrongTypeEmail, purpose: "transactional", category: "order" }),
        preferences.getMailSendDecision({ email: wrongTypeEmail, purpose: "marketing", category: "marketing" }),
      ]);
      assert.deepEqual(wrongTypeDecisions.map((decision) => decision.allowed), [true, true, false], JSON.stringify(wrongTypeDecisions));
      assert.equal(redis.run(["TYPE", wrongTypeKey]), "string");
      assert.equal(JSON.parse(redis.run(["GET", wrongTypeKey])).suppression.scope, "marketing");

      const hardEmail = "real-hard-suppressed-corrupt@example.com";
      const hardId = preferences.mailContactId(hardEmail);
      const hardKey = preferences.mailPreferenceInternals.contactKey(hardId);
      redis.run(["SADD", "lm:mail:suppressed:all", hardId]);
      redis.run(["SET", hardKey, "{broken"]);
      const hardDecision = await preferences.getMailSendDecision({ email: hardEmail, purpose: "critical", category: "security" });
      assert.equal(hardDecision.allowed, false);
      assert.equal(JSON.parse(redis.run(["GET", hardKey])).suppression.scope, "all");

      const orphanEmail = "real-orphan-hard-suppression@example.com";
      const orphanId = preferences.mailContactId(orphanEmail);
      const orphanKey = preferences.mailPreferenceInternals.contactKey(orphanId);
      redis.run(["SADD", "lm:mail:suppressed:all", orphanId]);
      assert.equal(redis.run(["GET", orphanKey]), null);
      const orphanDecision = await preferences.getMailSendDecision({ email: orphanEmail, purpose: "critical", category: "security" });
      assert.equal(orphanDecision.allowed, false);
      assert.equal(JSON.parse(redis.run(["GET", orphanKey])).suppression.scope, "all");
    });

    await t.test("signed token repairs a contact tombstone and one-click opt-out remains usable", async () => {
      const email = "real-token-corrupt@example.com";
      const token = await preferences.createMailPreferenceToken(email);
      const contactId = preferences.mailContactId(email);
      const key = preferences.mailPreferenceInternals.contactKey(contactId);
      redis.run(["SET", key, "null"]);
      const read = await preferences.getMailPreferencesByToken(token);
      assert.equal(read.ok, true);
      assert.equal(read.suppression.scope, "marketing");
      const unsubscribe = await preferences.unsubscribeMailToken(token, "real_redis_probe");
      assert.equal(unsubscribe.ok, true);
      assert.equal(unsubscribe.contact.suppression.scope, "marketing");

      const concurrentEmail = "real-token-concurrent@example.com";
      const concurrentToken = await preferences.createMailPreferenceToken(concurrentEmail);
      const concurrentId = preferences.mailContactId(concurrentEmail);
      redis.run(["SET", preferences.mailPreferenceInternals.contactKey(concurrentId), "{bad"]);
      const concurrentReads = await Promise.all(Array.from({ length: 5 }, () => preferences.getMailPreferencesByToken(concurrentToken)));
      assert.equal(concurrentReads.every((result) => result.ok && result.suppression.scope === "marketing"), true);
    });

    await t.test("invalid legacy revisions converge through concurrent CAS updates", async () => {
      const shapes = ["bad", -1, 1.5, 9007199254740992, null, {}];
      for (let index = 0; index < shapes.length; index += 1) {
        const email = `real-revision-${index}@example.com`;
        const contact = await preferences.ensureMailContact(email, { source: "real_probe" });
        const key = preferences.mailPreferenceInternals.contactKey(contact.contactId);
        const stored = JSON.parse(redis.run(["GET", key]));
        stored.revision = shapes[index];
        redis.run(["SET", key, JSON.stringify(stored)]);
        const results = await Promise.all([
          preferences.updateMailPreferences({ email, preferences: { renewal: false }, source: "real_probe" }),
          preferences.updateMailPreferences({ email, preferences: { serviceNotices: false }, source: "real_probe" }),
        ]);
        assert.equal(results.every((result) => result.ok), true);
        const updated = await preferences.getMailContact(email);
        assert.equal(Number.isSafeInteger(updated.revision), true);
        assert.equal(updated.revision >= 2, true);
        assert.equal(updated.preferences.renewal, false);
        assert.equal(updated.preferences.serviceNotices, false);
      }
    });

    await t.test("a committed soft-bounce CAS with a lost response is recovered without double counting", async () => {
      const email = "real-cas-response-loss@example.com";
      let dropped = false;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (!dropped && url.pathname !== "/pipeline") {
          const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
          if (String(command[0]).toUpperCase() === "EVAL" && String(command[1]).includes("CONTACT_CAS_V2")) {
            redis.run(command);
            dropped = true;
            return Response.json({ result: null });
          }
        }
        return redis.fetch(input, init);
      };
      const feedback = { email, status: "delayed", eventType: "soft_bounce", reason: "mailbox full", provider: "brevo", eventId: "real-cas-loss-1" };
      const first = await preferences.applyMailFeedback(feedback);
      globalThis.fetch = redis.fetch;
      const replay = await preferences.applyMailFeedback(feedback);
      assert.equal(dropped, true);
      assert.equal(first.ok, true);
      assert.equal(replay.ok, true);
      assert.equal((await preferences.getMailContact(email)).softBounce.count, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
