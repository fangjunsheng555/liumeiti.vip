import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

process.env.KV_REST_API_URL = "http://catalog-preflight.redis.test";
process.env.KV_REST_API_TOKEN = "catalog-preflight-token";

const catalog = await import("../app/api/_catalog-versions.js");

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
        return Response.json(commands.map((command) => ({ result: run(command) })));
      }
      return Response.json({ result: run(url.pathname.split("/").slice(1).map(decodeURIComponent)) });
    },
  };
}

const actor = { staffId: 1, staffUsername: "catalog-probe" };
const initial = { products: { spotify: { plans: { member: { amount: 128 } } } } };

test("catalog Lua preflights are zero-write and catalog commits retain CAS semantics", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async (t) => {
  const container = `lm-catalog-preflight-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
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

    const reset = () => {
      Date.now = originalDateNow;
      redis.run(["FLUSHDB"]);
    };
    const versionKeys = () => redis.run(["KEYS", `${catalog.catalogVersionKeys.VERSION_PREFIX}*`]).sort();

    await t.test("baseline rejects a WRONGTYPE version index before creating any version key", async () => {
      reset();
      redis.run(["SET", catalog.catalogVersionKeys.VERSION_INDEX_KEY, "legacy-wrong-type"]);
      await assert.rejects(
        catalog.ensureCatalogBaseline(initial, actor),
        (error) => error?.code === "storage_type_error",
      );
      assert.equal(redis.run(["EXISTS", catalog.catalogVersionKeys.CURRENT_VERSION_KEY]), 0);
      assert.deepEqual(versionKeys(), []);
      assert.equal(redis.run(["GET", catalog.catalogVersionKeys.VERSION_INDEX_KEY]), "legacy-wrong-type");
    });

    await t.test("commit rejects a WRONGTYPE version index without changing overrides or current version", async () => {
      reset();
      const baseline = await catalog.ensureCatalogBaseline(initial, actor);
      const baselineKeys = versionKeys();
      redis.run(["DEL", catalog.catalogVersionKeys.VERSION_INDEX_KEY]);
      redis.run(["SET", catalog.catalogVersionKeys.VERSION_INDEX_KEY, "legacy-wrong-type"]);
      const committed = await catalog.commitCatalogVersion({
        overrides: { products: { spotify: { title: "must-not-persist" } } },
        previousOverrides: initial,
        expectedVersion: baseline,
        actor,
      });
      assert.deepEqual(committed, { ok: false, error: "version_commit_failed" });
      assert.equal(redis.run(["GET", catalog.catalogVersionKeys.CURRENT_VERSION_KEY]), baseline);
      assert.equal(redis.run(["EXISTS", catalog.catalogVersionKeys.OVERRIDES_KEY]), 0);
      assert.deepEqual(versionKeys(), baselineKeys);
      assert.equal(redis.run(["GET", catalog.catalogVersionKeys.VERSION_INDEX_KEY]), "legacy-wrong-type");
    });

    for (const [label, score] of [
      ["NaN", Number.NaN],
      ["fractional", 1_725_000_000_000.5],
      ["larger than MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 2],
    ]) {
      await t.test(`baseline rejects a ${label} score before every write`, async () => {
        reset();
        Date.now = () => score;
        await assert.rejects(
          catalog.ensureCatalogBaseline(initial, actor),
          (error) => error?.code === "invalid_version_record",
        );
        assert.equal(redis.run(["DBSIZE"]), 0);
      });

      await t.test(`commit rejects a ${label} score without changing the baseline`, async () => {
        reset();
        const baseline = await catalog.ensureCatalogBaseline(initial, actor);
        const baselineKeys = versionKeys();
        const baselineIndex = redis.run(["ZRANGE", catalog.catalogVersionKeys.VERSION_INDEX_KEY, "0", "-1", "WITHSCORES"]);
        Date.now = () => score;
        const result = await catalog.commitCatalogVersion({
          overrides: { products: { spotify: { title: `invalid-${label}` } } },
          previousOverrides: initial,
          expectedVersion: baseline,
          actor,
        });
        assert.deepEqual(result, { ok: false, error: "version_commit_failed" });
        assert.equal(redis.run(["GET", catalog.catalogVersionKeys.CURRENT_VERSION_KEY]), baseline);
        assert.equal(redis.run(["EXISTS", catalog.catalogVersionKeys.OVERRIDES_KEY]), 0);
        assert.deepEqual(versionKeys(), baselineKeys);
        assert.deepEqual(
          redis.run(["ZRANGE", catalog.catalogVersionKeys.VERSION_INDEX_KEY, "0", "-1", "WITHSCORES"]),
          baselineIndex,
        );
      });
    }

    await t.test("legacy-shaped overrides keep empty arrays, null and a 30-digit identifier", async () => {
      reset();
      const legacy = {
        products: {
          legacy: {
            rows: [],
            nullable: null,
            externalId: "123456789012345678901234567890",
          },
        },
      };
      const baseline = await catalog.ensureCatalogBaseline(legacy, actor);
      const stored = await catalog.getCatalogVersion(baseline);
      assert.deepEqual(stored.overrides.products.legacy.rows, []);
      assert.equal(stored.overrides.products.legacy.nullable, null);
      assert.equal(stored.overrides.products.legacy.externalId, "123456789012345678901234567890");
      const raw = redis.run(["GET", catalog.catalogVersionKeys.VERSION_PREFIX + baseline]);
      assert.match(raw, /"rows":\[\]/);
      assert.match(raw, /"nullable":null/);
      assert.match(raw, /"externalId":"123456789012345678901234567890"/);
    });

    await t.test("two commits with one expected version have exactly one CAS winner", async () => {
      reset();
      const baseline = await catalog.ensureCatalogBaseline(initial, actor);
      const [first, second] = await Promise.all([
        catalog.commitCatalogVersion({
          overrides: { products: { spotify: { title: "winner-a" } } },
          previousOverrides: initial,
          expectedVersion: baseline,
          actor,
        }),
        catalog.commitCatalogVersion({
          overrides: { products: { spotify: { title: "winner-b" } } },
          previousOverrides: initial,
          expectedVersion: baseline,
          actor,
        }),
      ]);
      const winners = [first, second].filter((result) => result.ok);
      const conflicts = [first, second].filter((result) => result.conflict);
      assert.equal(winners.length, 1);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].currentVersion, winners[0].currentVersion);
      assert.equal(redis.run(["GET", catalog.catalogVersionKeys.CURRENT_VERSION_KEY]), winners[0].currentVersion);
      const persisted = JSON.parse(redis.run(["GET", catalog.catalogVersionKeys.OVERRIDES_KEY]));
      assert.equal(persisted.products.spotify.title, winners[0].version.overrides.products.spotify.title);
      assert.equal(versionKeys().length, 2);
    });

    await t.test("a WRONGTYPE overrides key cannot create a detached version record", async () => {
      reset();
      const baseline = await catalog.ensureCatalogBaseline(initial, actor);
      const baselineKeys = versionKeys();
      redis.run(["LPUSH", catalog.catalogVersionKeys.OVERRIDES_KEY, "legacy"]);
      const result = await catalog.commitCatalogVersion({
        overrides: { products: {} },
        previousOverrides: initial,
        expectedVersion: baseline,
        actor,
      });
      assert.deepEqual(result, { ok: false, error: "version_commit_failed" });
      assert.equal(redis.run(["GET", catalog.catalogVersionKeys.CURRENT_VERSION_KEY]), baseline);
      assert.deepEqual(versionKeys(), baselineKeys);
      assert.deepEqual(redis.run(["LRANGE", catalog.catalogVersionKeys.OVERRIDES_KEY, "0", "-1"]), ["legacy"]);
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    docker(["rm", "-f", container]);
  }
});
