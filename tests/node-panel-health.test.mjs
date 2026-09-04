import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkNodePanel, describeNodePanelCheck, nodePanelConfigFromSettings } from "../app/api/_node-panel.js";
import { HEALTH_COMPONENTS, HEALTH_STALE_AFTER_MS } from "../app/api/_health.js";
import { mergeSettings } from "../app/lib/settings-defaults.js";

// The node panel fails silently: the site keeps taking orders while completed
// ones provision nothing and the customer's subscription serves an empty list.
// A probe on the maintenance tick, plus a button for staff, is what turns that
// into something anyone notices.

const TOKEN = "test-panel-token-0123456789abcdef";
const BASE = "https://panel.example:2053/ad/api/v1";
const config = (overrides) => nodePanelConfigFromSettings(mergeSettings({ nodePanel: { enabled: true, apiBase: BASE, apiToken: TOKEN, ...overrides } }));

function scriptedFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body });
    const next = replies.shift();
    if (!next) throw new Error("unexpected extra request " + url);
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

test("a healthy panel answers /ping with the token and nothing is written", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: { ok: true, version: "1.4.2", role: "master", time: 1 } }]);
  const result = await checkNodePanel({ config: config(), fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.version, "1.4.2");
  assert.ok(Number.isFinite(result.latencyMs));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET", "the probe must not write");
  assert.equal(calls[0].url, `${BASE}/ping`);
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].body, undefined);
  assert.match(describeNodePanelCheck(result), /面板可达/);
});

test("a wrong token reads as unreachable, because provisioning would fail the same way", async () => {
  // /ping is authenticated, so this single call covers both "panel is down"
  // and "the token in the settings is no longer the one it accepts".
  const { fetchImpl } = scriptedFetch([{ status: 401, body: { error: "外部 API 未开启或令牌错误" } }]);
  const result = await checkNodePanel({ config: config(), fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "panel_unauthorized");
  assert.equal(describeNodePanelCheck(result), "面板令牌无效或外部 API 未开启");
});

test("an unreachable host and a timeout are distinguished", async () => {
  const down = await checkNodePanel({ config: config(), fetchImpl: scriptedFetch([new TypeError("fetch failed")]).fetchImpl });
  assert.equal(down.error, "panel_unreachable");
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const slow = await checkNodePanel({ config: config(), fetchImpl: scriptedFetch([timeout]).fetchImpl });
  assert.equal(slow.error, "panel_timeout");
});

test("something that answers but is not the panel does not read as healthy", async () => {
  // A proxy error page or captive portal can return 200 with a JSON body.
  const { fetchImpl } = scriptedFetch([{ status: 200, body: { message: "hello" } }]);
  const result = await checkNodePanel({ config: config(), fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, "panel_unexpected_response");
  assert.equal(describeNodePanelCheck(result), "该地址响应的不是节点面板");
});

test("automation switched off is a state, not an outage", async () => {
  const { fetchImpl, calls } = scriptedFetch([]);
  const off = await checkNodePanel({ config: config({ enabled: false }), fetchImpl });
  assert.deepEqual([off.ok, off.status, off.error], [false, "disabled", "panel_disabled"]);
  const noToken = await checkNodePanel({ config: config({ apiToken: "" }), fetchImpl });
  assert.deepEqual([noToken.status, noToken.error], ["failed", "panel_not_configured"]);
  assert.equal(calls.length, 0, "neither state may touch the network");
});

test("the token never appears in a probe result", async () => {
  const { fetchImpl } = scriptedFetch([{ status: 401, body: { error: `token ${TOKEN} rejected` } }]);
  const result = await checkNodePanel({ config: config(), fetchImpl });
  assert.equal((JSON.stringify(result) + describeNodePanelCheck(result)).includes(TOKEN), false);
});

// ── Wiring ─────────────────────────────────────────────────────────────────

const cron = await readFile(new URL("../app/api/cron/maintenance/route.js", import.meta.url), "utf8");
const adminRoute = await readFile(new URL("../app/api/admin/node-panel/route.js", import.meta.url), "utf8");
const settingsPanel = await readFile(new URL("../app/admin/SettingsPanel.jsx", import.meta.url), "utf8");
const healthRoute = await readFile(new URL("../app/api/admin/health/route.js", import.meta.url), "utf8");

test("the panel is a first-class health component with a label", () => {
  assert.ok(HEALTH_COMPONENTS.includes("node_panel"));
  assert.ok(Number.isFinite(HEALTH_STALE_AFTER_MS.node_panel), "a component without a staleness budget never goes stale");
  assert.match(healthRoute, /node_panel: "机场节点面板"/);
});

test("the maintenance tick probes the panel and routes failures through the incident channel", () => {
  assert.match(cron, /async function evaluateNodePanel/);
  assert.match(cron, /evaluateNodePanel\(\{ deadlineAt: monitoringDeadlineAt \}\)/);
  assert.match(cron, /fingerprint = "node-panel:reachability"/);
  // Deduplicated alerting and its automatic recovery notice, same as the API
  // signals already use — not a bare Telegram call on every failed tick.
  assert.match(cron, /reportOperationalFailure\(\{[\s\S]*?component: "node_panel"/);
  assert.match(cron, /reportOperationalRecovery\(\{ fingerprint, component: "node_panel", title: "机场节点面板已恢复" \}\)/);
  assert.match(cron, /severity: "P1"/);
  // Switching automation off must clear a standing incident, not leave it open.
  assert.match(cron, /机场节点面板自动开通已关闭/);
  assert.match(cron, /const nodePanel = monitoring\[2\]/);
  assert.match(cron, /nodePanel, monitoringErrors/);
});

test("a probe failure is a reported failure, never a silently swallowed one", () => {
  // requireIncidentSync throws when the incident could not be recorded, and
  // the handler turns a rejected monitoring promise into monitoringErrors and
  // a 503 — so a broken alert path cannot look like a healthy tick.
  assert.match(cron, /requireIncidentSync\(await reportOperationalFailure/);
  assert.match(cron, /node_panel_health_write_failed/);
});

test("staff can probe on demand, and only the role that can edit the token", () => {
  assert.match(adminRoute, /isRootAdminSession\(session\)/);
  assert.match(adminRoute, /checkNodePanel\(\{ config \}\)/);
  assert.match(adminRoute, /nodePanelConfigFromSettings\(await getSettings\(\)\)/);
  // The manual probe is a real sample: testing after a token change clears the
  // alert instead of waiting for the next tick.
  assert.match(adminRoute, /recordHealthStatus\("node_panel"/);
  assert.doesNotMatch(adminRoute, /apiToken|config\.token/, "the route must never echo the token");
  assert.match(settingsPanel, /fetch\("\/api\/admin\/node-panel", \{ method: "POST"/);
  assert.match(settingsPanel, /测试接口可用性/);
  // A result from before a save describes the previous token.
  assert.match(settingsPanel, /setFieldErrors\(\{\}\); setPanelTest\(null\);/);
});
