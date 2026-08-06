import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "admin-settings-route-secret-at-least-32-characters";
process.env.KV_REST_API_URL = "http://settings.redis.test";
process.env.KV_REST_API_TOKEN = "settings-test-token";

const values = new Map();
const pipelineRequests = [];
const originalFetch = globalThis.fetch;
let failAllRedis = false;
let failActionLog = false;

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "GET") return values.get(args[0]) ?? null;
  if (name === "PING") return "PONG";
  if (name === "LPUSH" || name === "LTRIM") return 1;
  if (name === "EVAL") {
    const script = String(args[0] || "");
    const keyCount = Number(args[1] || 0);
    const keys = args.slice(2, 2 + keyCount);
    const argv = args.slice(2 + keyCount);
    if (!script.includes("__settings_corrupt__") || keys.length !== 2) throw new Error("unexpected settings EVAL");
    const expected = Number(argv[0]);
    const currentRaw = values.get(keys[1]);
    if (currentRaw != null && !/^\d+$/.test(String(currentRaw))) return "__revision_corrupt__";
    const current = Number(currentRaw || 0);
    if (!values.has(keys[0]) && current !== 0) return "__settings_corrupt__";
    if (current !== expected) return `__conflict__:${current}`;
    if (values.has(keys[0])) {
      try {
        const existing = JSON.parse(values.get(keys[0]));
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) return "__settings_corrupt__";
      } catch {
        return "__settings_corrupt__";
      }
    }
    const parsed = JSON.parse(argv[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "__invalid_settings__";
    values.set(keys[0], argv[1]);
    values.set(keys[1], String(current + 1));
    return String(current + 1);
  }
  throw new Error(`unexpected Redis command ${name}`);
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://settings.redis.test") return originalFetch(input, options);
  if (failAllRedis) return new Response("unavailable", { status: 503 });
  assert.equal(url.pathname, "/pipeline", "settings storage must use Redis pipeline POSTs");
  assert.equal(options.method, "POST");
  const commands = JSON.parse(options.body || "[]");
  pipelineRequests.push(commands);
  if (failActionLog && commands.some((command) => command[0] === "LPUSH")) {
    return new Response("audit unavailable", { status: 503 });
  }
  return Response.json({ result: commands.map((command) => ({ result: execute(command) })) });
};

const utils = await import("../app/api/_utils.js");
const route = await import("../app/api/admin/settings/route.js");
const { SETTINGS_DEFAULTS } = await import("../app/lib/settings-defaults.js");
const { SETTINGS_KEY, SETTINGS_REVISION_KEY } = await import("../app/api/_settings.js");

const adminToken = utils.signSession({
  role: "admin",
  staffId: 1,
  staffUsername: "admin",
  exp: Date.now() + 60_000,
});

function request(method, body, raw = false) {
  return new Request("https://www.liumeiti.vip/api/admin/settings", {
    method,
    headers: {
      cookie: `lm_admin=${encodeURIComponent(adminToken)}`,
      "Content-Type": "application/json",
    },
    ...(method === "PUT" ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
}

function validSettings() {
  return structuredClone(SETTINGS_DEFAULTS);
}

function reset() {
  values.clear();
  pipelineRequests.length = 0;
  failAllRedis = false;
  failActionLog = false;
}

test.after(() => { globalThis.fetch = originalFetch; });

test("admin settings GET is strict while legacy data without a revision starts at version zero", async () => {
  reset();
  values.set(SETTINGS_KEY, JSON.stringify({ brand: { name: "旧站点" } }));
  const response = await route.GET(request("GET"));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.currentVersion, 0);
  assert.equal(payload.settings.brand.name, "旧站点");

  values.set(SETTINGS_KEY, "{not-json");
  const corrupt = await route.GET(request("GET"));
  assert.equal(corrupt.status, 503);
  assert.equal((await corrupt.json()).error, "settings_store_corrupt");

  failAllRedis = true;
  const unavailable = await route.GET(request("GET"));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "settings_store_unavailable");
});

test("missing settings or malformed JSON is rejected with field errors", async () => {
  reset();
  const missing = await route.PUT(request("PUT", { baseVersion: 0 }));
  assert.equal(missing.status, 400);
  assert.ok((await missing.json()).fieldErrors.settings);

  const malformed = await route.PUT(request("PUT", "{", true));
  assert.equal(malformed.status, 400);
  assert.ok((await malformed.json()).fieldErrors.settings);
  assert.equal(pipelineRequests.length, 0);
});

test("links, TRON address, discount ordering, precision and booleans fail explicitly", async (t) => {
  const cases = [
    ["non-QQ links reject unsafe protocols", (s) => { s.support.telegram.href = "javascript:alert(1)"; }, "support.telegram.href"],
    ["TRON address must be a 34-character Base58 address", (s) => { s.usdt.address = "0x1234"; }, "usdt.address"],
    ["three-item discount cannot be below two-item discount", (s) => { s.bundle.tier2Rate = 0.2; s.bundle.tier3Rate = 0.1; }, "bundle.tier3Rate"],
    ["fixed exchange rate is bounded", (s) => { s.usdt.rateOverride = "1000.1"; }, "usdt.rateOverride"],
    ["money settings reject excessive precision", (s) => { s.usdt.discount = "0.912345"; }, "usdt.discount"],
    ["notification flags are actual booleans", (s) => { s.notify.telegramEnabled = "true"; }, "notify.telegramEnabled"],
  ];
  for (const [name, mutate, field] of cases) {
    await t.test(name, async () => {
      reset();
      const settings = validSettings();
      mutate(settings);
      const response = await route.PUT(request("PUT", { settings, baseVersion: 0 }));
      assert.equal(response.status, 400);
      assert.ok((await response.json()).fieldErrors[field]);
      assert.equal(values.has(SETTINGS_KEY), false);
    });
  }
});

test("images accept only safe bounded sources", async (t) => {
  for (const [name, image] of [
    ["SVG data URLs are rejected", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
    ["protocol-relative URLs are rejected", "//evil.example/qr.png"],
    ["oversized data URLs are rejected", `data:image/png;base64,${"A".repeat(500004)}`],
  ]) {
    await t.test(name, async () => {
      reset();
      const settings = validSettings();
      settings.payment.alipayQr = image;
      const response = await route.PUT(request("PUT", { settings, baseVersion: 0 }));
      assert.equal(response.status, 400);
      assert.ok((await response.json()).fieldErrors["payment.alipayQr"]);
      assert.equal(values.has(SETTINGS_KEY), false);
    });
  }
});

test("legacy settings initialize revision atomically and stale writers receive 409", async () => {
  reset();
  values.set(SETTINGS_KEY, JSON.stringify(validSettings()));
  const settings = validSettings();
  settings.brand.name = "第一位管理员";
  const saved = await route.PUT(request("PUT", { settings, baseVersion: 0 }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).currentVersion, 1);
  assert.equal(values.get(SETTINGS_REVISION_KEY), "1");
  assert.equal(JSON.parse(values.get(SETTINGS_KEY)).brand.name, "第一位管理员");

  const staleSettings = validSettings();
  staleSettings.brand.name = "过期编辑";
  const stale = await route.PUT(request("PUT", { settings: staleSettings, baseVersion: 0 }));
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { ok: false, error: "version_conflict", currentVersion: 1 });
  assert.equal(JSON.parse(values.get(SETTINGS_KEY)).brand.name, "第一位管理员");
  assert.ok(pipelineRequests.some((commands) => commands[0]?.[0] === "EVAL" && commands[1]?.[0] === "PING"));
});

test("audit log failure after the primary CAS does not turn a saved setting into an error", async () => {
  reset();
  failActionLog = true;
  const settings = validSettings();
  settings.brand.name = "日志失败仍保存";
  const response = await route.PUT(request("PUT", { settings, baseVersion: 0 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).currentVersion, 1);
  assert.equal(JSON.parse(values.get(SETTINGS_KEY)).brand.name, "日志失败仍保存");
});

test("a stale loaded editor cannot overwrite a settings document that became corrupt", async () => {
  reset();
  values.set(SETTINGS_KEY, "{broken-json");
  values.set(SETTINGS_REVISION_KEY, "7");
  const settings = validSettings();
  settings.brand.name = "不得覆盖损坏正文";
  const response = await route.PUT(request("PUT", { settings, baseVersion: 7 }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "settings_store_corrupt");
  assert.equal(values.get(SETTINGS_KEY), "{broken-json");
  assert.equal(values.get(SETTINGS_REVISION_KEY), "7");
});
