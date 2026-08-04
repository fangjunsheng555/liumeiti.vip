import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.KV_REST_API_URL = "http://telegram-marker-loss.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
process.env.TELEGRAM_CHAT_ID = "987654";

const telegram = await import("../app/api/_telegram-alerts.js");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

test("a real Redis marker commit with a lost response permits exactly one initial provider call", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 90_000,
}, async () => {
  const container = `lm-telegram-marker-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  let responseLost = false;
  const run = (command) => {
    const child = docker(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis-cli failed");
    const output = child.stdout.trim();
    if (/^error:/i.test(output)) throw new Error(output);
    return output ? JSON.parse(output) : null;
  };
  try {
    for (let attempt = 0; attempt < 40 && docker(["exec", container, "redis-cli", "PING"]).stdout.trim() !== "PONG"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin === "https://api.telegram.org") {
        providerCalls += 1;
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      if (url.pathname === "/pipeline") {
        const commands = JSON.parse(String(init.body || "[]"));
        return Response.json(commands.map((command) => {
          try { return { result: run(command) }; } catch (error) { return { error: error.message }; }
        }));
      }
      const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
      const result = run(command);
      if (!responseLost && command[0] === "EVAL" && String(command[1]).includes("telegram_invalid_retry_record")) {
        responseLost = true;
        return Response.json({ result: null });
      }
      return Response.json({ result });
    };

    assert.equal(providerCalls, 0);
    const result = await telegram.sendOperationalTelegram({
      fingerprint: "probe:telegram-marker-response-loss",
      incidentId: "INC-MARKER-LOSS",
      event: "opened",
      text: "marker committed before the response disappeared",
    });
    assert.equal(responseLost, true);
    assert.equal(result.ok, true);
    assert.equal(providerCalls, 1);
    assert.deepEqual(await telegram.readTelegramRetryQueue(), []);
  } finally {
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
