import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET = "catalog-partial-failure-secret-at-least-32-characters";
process.env.KV_REST_API_URL = "http://catalog-partial.redis.test";
process.env.KV_REST_API_TOKEN = "catalog-partial-token";
process.env.VERCEL_ENV = "preview";

const values = new Map();
const scores = new Map();
let pipelineErrorKey = "";
const originalFetch = globalThis.fetch;

function execute(command) {
  const [rawName, ...args] = command;
  const name = String(rawName || "").toUpperCase();
  if (name === "GET") return values.get(args[0]) ?? null;
  if (name === "ZREVRANGE") {
    const start = Number(args[1]);
    const stop = Number(args[2]);
    const ordered = [...scores.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([id]) => id);
    return ordered.slice(start, stop < 0 ? undefined : stop + 1);
  }
  if (name === "PING") return "PONG";
  if (name === "HINCRBY" || name === "EXPIRE") return 1;
  throw new Error(`unexpected Redis command ${name}`);
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.origin !== "http://catalog-partial.redis.test") return originalFetch(input, options);
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(String(options.body || "[]"));
    return Response.json(commands.map((command) => (
      String(command?.[0] || "").toUpperCase() === "GET" && command?.[1] === pipelineErrorKey
        ? { error: "injected catalog transport failure" }
        : { result: execute(command) }
    )));
  }
  return Response.json({
    result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)),
  });
};

const catalog = await import("../app/api/_catalog-versions.js");
const utils = await import("../app/api/_utils.js");
const route = await import("../app/api/admin/catalog/versions/route.js");

const adminToken = utils.signSession({
  role: "admin",
  staffId: 1,
  staffUsername: "catalog-test",
  exp: Date.now() + 60_000,
});

function makeVersion(id, createdAt, overrides, actor, summary, source) {
  return {
    id,
    createdAt,
    overrides,
    actor,
    summary,
    source,
    note: "",
    rollbackFrom: "",
    previousVersion: "",
  };
}

function storeVersion(id, score, record) {
  scores.set(id, score);
  values.set(catalog.catalogVersionKeys.VERSION_PREFIX + id, JSON.stringify(record));
}

function validVersion(id, createdAt) {
  return makeVersion(
    id,
    createdAt,
    { products: { netflix: { title: id } } },
    { staffId: 1, staffUsername: "catalog-test" },
    { productKeys: ["netflix"], productCount: 1, fieldCount: 1, changes: [] },
    "save",
  );
}

function reset() {
  values.clear();
  scores.clear();
  pipelineErrorKey = "";
}

test.after(() => { globalThis.fetch = originalFetch; });

test("catalog history route skips records with missing fields, wrong types, and invalid dates", async () => {
  reset();
  const currentId = "CVCURRENTVALID001";
  const olderId = "CVOLDERVALID0001";
  const missingFieldId = "CVMISSINGACTOR01";
  const wrongTypeId = "CVWRONGTYPE0001";
  const invalidDateId = "CVINVALIDDATE001";
  values.set(catalog.catalogVersionKeys.CURRENT_VERSION_KEY, currentId);
  storeVersion(currentId, 500, validVersion(currentId, "2026-08-09T06:00:00.000Z"));
  storeVersion(
    missingFieldId,
    400,
    makeVersion(
      missingFieldId,
      "2026-08-09T05:00:00.000Z",
      { products: {} },
      null,
      { productCount: 0 },
      "save",
    ),
  );
  storeVersion(
    wrongTypeId,
    300,
    makeVersion(
      wrongTypeId,
      "2026-08-09T04:00:00.000Z",
      { products: [] },
      { staffId: 1 },
      { productCount: 0 },
      "save",
    ),
  );
  storeVersion(invalidDateId, 200, validVersion(invalidDateId, "not-a-date"));
  storeVersion(olderId, 100, validVersion(olderId, "2026-08-08T03:00:00.000Z"));

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    const response = await route.GET(new Request("https://www.liumeiti.vip/api/admin/catalog/versions", {
      headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
    }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.currentVersion, currentId);
    assert.deepEqual(payload.versions.map((entry) => entry.id), [currentId, olderId]);
    assert.ok(warnings.some((entry) => entry.includes("ignored 3 corrupt historical version entries")));
  } finally {
    console.warn = originalWarn;
  }
});

test("catalog history route scans past a corrupt first window to return older valid versions", async () => {
  reset();
  const currentId = "CVCURRENTOVERSCAN1";
  const olderIds = ["CVOVERSCANOLDER01", "CVOVERSCANOLDER02"];
  values.set(catalog.catalogVersionKeys.CURRENT_VERSION_KEY, currentId);
  storeVersion(currentId, 1000, validVersion(currentId, "2026-08-09T08:00:00.000Z"));
  for (let index = 0; index < 65; index += 1) {
    const id = `CVCORRUPT${String(index).padStart(3, "0")}`;
    scores.set(id, 900 - index);
    values.set(catalog.catalogVersionKeys.VERSION_PREFIX + id, index % 2 ? "{bad-json" : JSON.stringify({ id }));
  }
  olderIds.forEach((id, index) => {
    storeVersion(id, 100 - index, validVersion(id, `2026-08-08T0${index + 1}:00:00.000Z`));
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const response = await route.GET(new Request("https://www.liumeiti.vip/api/admin/catalog/versions", {
      headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
    }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.versions.map((entry) => entry.id), [currentId, ...olderIds]);
  } finally {
    console.warn = originalWarn;
  }
});

test("a corrupt historical single lookup is treated as not found", async () => {
  reset();
  const corruptId = "CVSINGLECORRUPT1";
  values.set(catalog.catalogVersionKeys.VERSION_PREFIX + corruptId, JSON.stringify({
    id: corruptId,
    overrides: { products: {} },
    createdAt: null,
  }));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await catalog.getCatalogVersion(corruptId), null);
  } finally {
    console.warn = originalWarn;
  }
});

test("a corrupt active catalog snapshot remains a hard storage fault", async () => {
  reset();
  const currentId = "CVCURRENTBROKEN01";
  const historicalId = "CVHISTORYVALID001";
  values.set(catalog.catalogVersionKeys.CURRENT_VERSION_KEY, currentId);
  storeVersion(currentId, 200, validVersion(currentId, "invalid-current-date"));
  storeVersion(historicalId, 100, validVersion(historicalId, "2026-08-08T03:00:00.000Z"));
  await assert.rejects(
    catalog.listCatalogVersions(30),
    (error) => error?.message === "catalog_version_storage_corrupt",
  );
});

test("the active snapshot is validated even when a damaged index omits it", async () => {
  reset();
  const currentId = "CVCURRENTUNINDEX1";
  const historicalId = "CVINDEXEDVALID001";
  values.set(catalog.catalogVersionKeys.CURRENT_VERSION_KEY, currentId);
  values.set(
    catalog.catalogVersionKeys.VERSION_PREFIX + currentId,
    JSON.stringify(validVersion(currentId, "2026-08-09T06:00:00.000Z")),
  );
  storeVersion(historicalId, 100, validVersion(historicalId, "2026-08-08T03:00:00.000Z"));
  const state = await catalog.listCatalogVersions(30);
  assert.equal(state.currentVersion, currentId);
  assert.deepEqual(state.versions.map((entry) => entry.id), [historicalId]);

  values.set(catalog.catalogVersionKeys.VERSION_PREFIX + currentId, "{broken-json");
  await assert.rejects(
    catalog.listCatalogVersions(30),
    (error) => error?.message === "catalog_version_storage_corrupt",
  );
});

test("per-command Redis errors remain transport faults for single and history reads", async () => {
  reset();
  const versionId = "CVPIPELINEERROR01";
  values.set(catalog.catalogVersionKeys.CURRENT_VERSION_KEY, versionId);
  storeVersion(versionId, 100, validVersion(versionId, "2026-08-09T06:00:00.000Z"));
  pipelineErrorKey = catalog.catalogVersionKeys.VERSION_PREFIX + versionId;
  await assert.rejects(
    catalog.getCatalogVersion(versionId),
    (error) => error?.message === "catalog_version_storage_error",
  );
  await assert.rejects(
    catalog.listCatalogVersions(30),
    (error) => error?.message === "catalog_version_storage_error",
  );
});
