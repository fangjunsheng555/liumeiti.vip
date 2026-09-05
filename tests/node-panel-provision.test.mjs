import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  describeNodeProvision,
  invalidNodeSubscriptionLinkUpdate,
  missingNodeSubscriptionLink,
  nodePanelConfigFromSettings,
  panelPlanForItem,
  provisionNodeOrder,
} from "../app/api/_node-panel.js";
import { rocketSubscriptionUrl } from "../app/lib/rocket-subscription.js";
import {
  SETTINGS_DEFAULTS,
  mergeSettings,
  publicSiteSettings,
  validateSettingsSubmission,
} from "../app/lib/settings-defaults.js";

// Marking a node order completed creates the panel user named after the order
// and applies the plan. These pin the request shapes the panel's external API
// (m-ui web/public_api.go) actually accepts, the idempotency on re-runs, that
// configuration comes from the site settings, and that the token never leaks
// into anything the site records, shows, or serves to browsers.

const TOKEN = "test-panel-token-0123456789abcdef";
const BASE = "https://panel.example:2053/ad/api/v1";
const ORDER_ID = "LM7D4E5F6A7B8C9D0E1F";

function settingsWithPanel(overrides = {}) {
  return mergeSettings({ nodePanel: { enabled: true, apiBase: BASE, apiToken: TOKEN, ...overrides } });
}
const config = (overrides) => nodePanelConfigFromSettings(settingsWithPanel(overrides));

function nodeOrder(plan = "basic", extraItems = []) {
  return {
    orderId: ORDER_ID,
    status: "completed",
    items: [{ service: "rocket", label: "机场节点 · 普通套餐", plan, planLabel: "普通套餐", cycle: "1年", amount: 108 }, ...extraItems],
  };
}

function panelUser(overrides = {}) {
  return {
    id: 7, name: ORDER_ID, enabled: true, volume: 600 * 2 ** 30, used: 0, expiry: 0,
    subLink: `https://panel.example:2056/sub/${ORDER_ID}`,
    subClash: `https://panel.example:2056/sub/${ORDER_ID}?format=clash`,
    ...overrides,
  };
}

// A scripted fetch: each call pops the next scripted reply and records what
// was sent, so tests assert both the outcome and the exact requests made.
function scriptedFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
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

// ── Configuration lives in the site settings ───────────────────────────────

test("automation is off until staff enable it and enter a token in the site settings", async () => {
  assert.equal(nodePanelConfigFromSettings(mergeSettings({})).configured, false);
  assert.equal(nodePanelConfigFromSettings(settingsWithPanel({ enabled: false })).configured, false);
  assert.equal(nodePanelConfigFromSettings(settingsWithPanel({ apiToken: "" })).configured, false);
  assert.equal(config().configured, true);
  const { fetchImpl, calls } = scriptedFetch([]);
  const result = await provisionNodeOrder(nodeOrder(), { config: nodePanelConfigFromSettings(mergeSettings({})), fetchImpl });
  assert.deepEqual([result.ok, result.status, result.error], [false, "skipped", "panel_not_configured"]);
  assert.equal(calls.length, 0);
});

test("the token is never served to browsers", () => {
  const visible = publicSiteSettings(settingsWithPanel());
  assert.equal("nodePanel" in visible, false);
  assert.equal(JSON.stringify(visible).includes(TOKEN), false);
  // Everything customers do need is still there.
  for (const section of ["support", "brand", "footer", "usdt", "bundle", "payment", "notify"]) {
    assert.ok(visible[section], `${section} must survive the public strip`);
  }
});

test("the admin validator accepts the panel section and rejects what would break provisioning", () => {
  const base = JSON.parse(JSON.stringify(mergeSettings({})));
  const ok = validateSettingsSubmission({ ...base, nodePanel: { enabled: true, apiBase: `${BASE}/`, apiToken: ` ${TOKEN} `, planNames: { ...SETTINGS_DEFAULTS.nodePanel.planNames, basic: "标准" } } });
  assert.equal(ok.ok, true, JSON.stringify(ok.fieldErrors));
  assert.equal(ok.settings.nodePanel.apiBase, BASE, "a trailing slash is normalized away");
  assert.equal(ok.settings.nodePanel.apiToken, TOKEN, "the token is trimmed");
  assert.equal(ok.settings.nodePanel.planNames.basic, "标准");

  const enabledWithoutToken = validateSettingsSubmission({ ...base, nodePanel: { ...base.nodePanel, enabled: true, apiToken: "" } });
  assert.equal(enabledWithoutToken.ok, false);
  assert.match(enabledWithoutToken.fieldErrors["nodePanel.apiToken"], /令牌/);

  const httpBase = validateSettingsSubmission({ ...base, nodePanel: { ...base.nodePanel, apiBase: "http://panel.example/api/v1" } });
  assert.equal(httpBase.ok, false);
  assert.ok(httpBase.fieldErrors["nodePanel.apiBase"]);

  const tokenWithSpace = validateSettingsSubmission({ ...base, nodePanel: { ...base.nodePanel, apiToken: "abc def" } });
  assert.equal(tokenWithSpace.ok, false);
  assert.ok(tokenWithSpace.fieldErrors["nodePanel.apiToken"]);

  const missingPlanName = validateSettingsSubmission({ ...base, nodePanel: { ...base.nodePanel, planNames: { ...base.nodePanel.planNames, trial: "" } } });
  assert.equal(missingPlanName.ok, false);
  assert.ok(missingPlanName.fieldErrors["nodePanel.planNames.trial"]);

  const disabledWithoutToken = validateSettingsSubmission({ ...base, nodePanel: { ...base.nodePanel, enabled: false, apiToken: "" } });
  assert.equal(disabledWithoutToken.ok, true, "leaving automation off needs no token");
});

test("site plan ids map to the names staff gave the panel plans", () => {
  const names = config().planNames;
  assert.deepEqual(names, { basic: "Standard", pro: "Plus", luxury: "Premium", unlimited: "Unlimited", trial: "trial" });
  assert.equal(panelPlanForItem({ plan: "luxury" }, names).name, "Premium");
  // The historical field name still resolves.
  assert.equal(panelPlanForItem({ rocketPlan: "pro" }, names).name, "Plus");
  assert.equal(panelPlanForItem({ plan: "mystery" }, names).name, "");
  // A renamed panel plan takes effect through the settings, without a deploy.
  assert.equal(config({ planNames: { basic: "标准" } }).planNames.basic, "标准");
  assert.equal(config({ planNames: { basic: "标准" } }).planNames.pro, "Plus");
});

// ── Provisioning against the panel ─────────────────────────────────────────

test("a new order creates the panel user with the plan in one call", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 404, body: { error: "用户不存在" } },
    { status: 200, body: panelUser() },
  ]);
  const result = await provisionNodeOrder(nodeOrder("basic"), { config: config(), fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, "done");
  assert.equal(result.existed, false);
  assert.equal(result.plan, "Standard");
  assert.equal(result.subLink, `https://panel.example:2056/sub/${ORDER_ID}`);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${BASE}/users/${ORDER_ID}`);
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, `${BASE}/users`);
  assert.equal(calls[1].headers["Content-Type"], "application/json");
  // Exactly the fields public_api.go reads: name, plan by name, a remark.
  assert.equal(calls[1].body.name, ORDER_ID);
  assert.equal(calls[1].body.plan, "Standard");
  assert.match(calls[1].body.remark, new RegExp(`^订单 ${ORDER_ID}`));
  assert.equal("planId" in calls[1].body, false);
});

test("a user that already exists is left untouched and reported as done", async () => {
  // Whether an earlier attempt died after creating it or staff made it by
  // hand, applying the plan again would reset the customer's period.
  const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: panelUser({ enabled: true }) }]);
  const result = await provisionNodeOrder(nodeOrder("pro"), { config: config(), fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, "done");
  assert.equal(result.existed, true);
  assert.equal(calls.length, 1, "no create or plan call may follow an existing user");
});

test("a duplicate-name rejection from a racing attempt reads the user back as done", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 404, body: { error: "用户不存在" } },
    { status: 400, body: { error: "用户名已存在" } },
    { status: 200, body: panelUser() },
  ]);
  const result = await provisionNodeOrder(nodeOrder(), { config: config(), fetchImpl });
  assert.equal(result.status, "done");
  assert.equal(result.existed, true);
  assert.equal(calls.length, 3);
});

test("a rejected token stops before any write and names the cause", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 401, body: { error: "外部 API 未开启或令牌错误" } }]);
  const result = await provisionNodeOrder(nodeOrder(), { config: config(), fetchImpl });
  assert.deepEqual([result.ok, result.status, result.error], [false, "failed", "panel_unauthorized"]);
  assert.equal(calls.length, 1);
  assert.equal(describeNodeProvision(result), "面板令牌无效或外部 API 未开启");
});

test("a panel that cannot be reached is a retryable failure, not a crash", async () => {
  const { fetchImpl } = scriptedFetch([new TypeError("fetch failed")]);
  const result = await provisionNodeOrder(nodeOrder(), { config: config(), fetchImpl });
  assert.deepEqual([result.ok, result.status, result.error], [false, "failed", "panel_unreachable"]);
});

test("a panel-side rejection carries the panel's own reason", async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 404, body: { error: "用户不存在" } },
    { status: 400, body: { error: "套餐不存在: Standard" } },
  ]);
  const result = await provisionNodeOrder(nodeOrder(), { config: config(), fetchImpl });
  assert.equal(result.status, "failed");
  assert.equal(result.error, "panel_rejected:套餐不存在: Standard");
  assert.equal(describeNodeProvision(result), "面板拒绝：套餐不存在: Standard");
});

test("orders that cannot be provisioned automatically say so instead of guessing", async () => {
  const { fetchImpl, calls } = scriptedFetch([]);
  const unmapped = await provisionNodeOrder(nodeOrder("mystery"), { config: config(), fetchImpl });
  assert.deepEqual([unmapped.status, unmapped.error], ["failed", "plan_unmapped:mystery"]);
  const twoNodes = await provisionNodeOrder(nodeOrder("basic", [{ service: "rocket", plan: "pro" }]), { config: config(), fetchImpl });
  assert.deepEqual([twoNodes.status, twoNodes.error], ["failed", "multiple_node_items"]);
  const notNode = await provisionNodeOrder({ orderId: ORDER_ID, items: [{ service: "netflix" }] }, { config: config(), fetchImpl });
  assert.deepEqual([notNode.status, notNode.error], ["skipped", "no_node_item"]);
  assert.equal(calls.length, 0, "none of these may touch the panel");
});

test("the token never appears in what is recorded or shown", async () => {
  const { fetchImpl } = scriptedFetch([{ status: 401, body: { error: `bad token ${TOKEN}` } }]);
  const result = await provisionNodeOrder(nodeOrder(), { config: config(), fetchImpl });
  const serialized = JSON.stringify(result) + describeNodeProvision(result);
  assert.equal(serialized.includes(TOKEN), false);
});

test("the panel's own address is what provisioning records", async () => {
  // The panel composes the subscription URL from its own host setting. Taking
  // its answer rather than rebuilding one keeps the two in step if that host
  // ever changes, and the builder stays as the fallback.
  const ISSUED = `https://panel.example:2056/sub/${ORDER_ID}`;
  const { fetchImpl } = scriptedFetch([
    { status: 404, body: { error: "not found" } },
    { status: 200, body: panelUser() },
  ]);
  const result = await provisionNodeOrder(nodeOrder(), { config: config(), fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.subLink, ISSUED);
  // Never the Clash variant the panel also offers: the plain address is the
  // landing page customers are told to open.
  assert.equal(result.subLink.includes("format="), false);

  // With no address in the reply the built one stands in, so a completed order
  // is never shown a blank link.
  const bare = scriptedFetch([
    { status: 404, body: { error: "not found" } },
    { status: 200, body: panelUser({ subLink: "" }) },
  ]);
  const fallback = await provisionNodeOrder(nodeOrder(), { config: config(), fetchImpl: bare.fetchImpl });
  assert.equal(fallback.subLink, rocketSubscriptionUrl(ORDER_ID));
  assert.equal(rocketSubscriptionUrl(ORDER_ID), `https://hk.joinvip.vip:2056/sub/${ORDER_ID}`);
});

test("a completion is refused while any node item would be left without a valid link", () => {
  const order = { orderId: ORDER_ID, items: [{ service: "netflix", label: "Netflix" }, { service: "rocket", label: "机场节点 · 普通套餐", subscriptionLinks: "" }] };
  assert.deepEqual(missingNodeSubscriptionLink(order, []), { index: 1, label: "机场节点 · 普通套餐" });
  // A link submitted with the edit satisfies it; a blank submitted link does
  // not, even if the item already held one.
  assert.equal(missingNodeSubscriptionLink(order, [{ index: 1, subscriptionLinks: `https://hk.joinvip.vip:2056/sub/${ORDER_ID}` }]), null);
  const stored = { ...order, items: [order.items[0], { ...order.items[1], subscriptionLinks: `https://hk.joinvip.vip:2056/sub/${ORDER_ID}?format=clash` }] };
  assert.equal(missingNodeSubscriptionLink(stored, []), null);
  assert.deepEqual(missingNodeSubscriptionLink(stored, [{ index: 1, subscriptionLinks: "   " }]), { index: 1, label: "机场节点 · 普通套餐" });
  // Orders without node items have nothing to check.
  assert.equal(missingNodeSubscriptionLink({ items: [{ service: "spotify" }] }, []), null);
  assert.equal(missingNodeSubscriptionLink({}, []), null);
});

test("a pasted link that is not an https address is refused whatever the status", () => {
  const order = { items: [{ service: "rocket", label: "机场节点" }] };
  for (const bad of ["http://hk.joinvip.vip/sub/x", "hk.joinvip.vip/sub/x", "https://hk.joinvip.vip/sub/x y", "javascript:alert(1)", "https://"]) {
    assert.deepEqual(invalidNodeSubscriptionLinkUpdate(order, [{ index: 0, subscriptionLinks: bad }]), { index: 0, label: "机场节点" }, bad);
  }
  for (const fine of ["", "  ", `https://hk.joinvip.vip:2056/sub/${ORDER_ID}`, " https://panel.example/sub/a "]) {
    assert.equal(invalidNodeSubscriptionLinkUpdate(order, [{ index: 0, subscriptionLinks: fine }]), null, JSON.stringify(fine));
  }
  assert.equal(invalidNodeSubscriptionLinkUpdate(order, [{ index: 0, account: "x" }]), null, "no link submitted, nothing to refuse");
});

// ── Wiring: staff generate the link while delivering, completion requires it, customers can see usage ──

const route = await readFile(new URL("../app/api/admin/orders/[orderId]/route.js", import.meta.url), "utf8");
const admin = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
const settingsPanel = await readFile(new URL("../app/admin/SettingsPanel.jsx", import.meta.url), "utf8");
const publicRoute = await readFile(new URL("../app/api/settings/route.js", import.meta.url), "utf8");
const serviceCentre = await readFile(new URL("../app/service-center/page.jsx", import.meta.url), "utf8");
const account = await readFile(new URL("../app/account/page.jsx", import.meta.url), "utf8");
const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");

test("completing a node order no longer calls the panel; the link must already be on the item", () => {
  // Provisioning at completion time waited on the panel and, when it lagged,
  // failed the completion. The link is now pasted or generated beforehand.
  assert.ok(!route.includes('trigger: "completion"'), "no provisioning is triggered by completion");
  assert.ok(!route.includes("provisionSaved"), "no completion-time provisioning save remains");
  assert.ok(route.includes("const missingLink = missingNodeSubscriptionLink(order, itemUpdates);"));
  assert.ok(route.includes('error: "subscription_link_required", itemIndex: missingLink.index, itemLabel: missingLink.label'));
  assert.ok(route.includes("const badLink = invalidNodeSubscriptionLinkUpdate(order, itemUpdates);"));
  assert.ok(route.includes('error: "subscription_link_invalid"'));
  // The gate runs before the order is touched — before item edits are applied
  // and before the status changes — so a refused completion leaves nothing
  // half-applied behind.
  const gate = route.indexOf("const missingLink = missingNodeSubscriptionLink(");
  assert.ok(gate > 0 && gate < route.indexOf("// Apply item updates") && gate < route.indexOf("order.status = newStatus;"));
  // Item edits carry the link; nothing is guessed on the server.
  assert.ok(route.includes('if (service === "rocket" && typeof upd.subscriptionLinks === "string") {'));
  assert.ok(route.includes("it.subscriptionLinks = clean(upd.subscriptionLinks, 300);"));
  assert.ok(!route.includes("it.subscriptionLinks = rocketSubscriptionUrl("), "the server must not mint a link");
  // The manual action still runs from the live settings and records its outcome.
  assert.ok(route.includes("provisionNodeOrder(order, { config: nodePanelConfigFromSettings(await getSettings()) })"));
  assert.ok(route.includes("order.nodeProvision = {"));
});

test("staff generate the link from the panel while delivering; only a voided order is refused", () => {
  assert.ok(route.includes('body.action === "node_provision"'));
  assert.ok(route.includes('error: "node_item_not_found"'));
  assert.ok(route.includes('error: "order_invalid"'));
  assert.ok(!route.includes('error: "order_not_completed"'), "generation must work before completion");
  assert.ok(route.includes('trigger: "manual"'));
  assert.ok(admin.includes('action: "node_provision"'));
  // The button sits beside the link field in the delivery workbench, and the
  // panel's address is written into that field on success.
  assert.ok(admin.includes("onGenerateSubscriptionLink={retryNodeProvision}"));
  assert.ok(admin.includes("generatingSubscriptionLink={nodeProvisionBusy}"));
  assert.ok(admin.includes('onSubscriptionLinkChange={(index, value) => updateItem(index, "subscriptionLinks", value)}'));
  assert.ok(admin.includes('const link = draft.service === "rocket" ? (latest?.subscriptionLinks || provision.subLink || "") : "";'));
  assert.ok(admin.includes('admin-node-provision-status is-${activeOrder.nodeProvision?.status || "pending"}'));
});

test("the delivery workbench has a link field with a generate button, and the form refuses completion without it", async () => {
  const workbench = await readFile(new URL("../app/admin/DeliveryWorkbench.jsx", import.meta.url), "utf8");
  assert.ok(workbench.includes("onChange={(event) => onLinkChange?.(event.target.value)}"));
  assert.ok(workbench.includes("面板生成"));
  assert.ok(workbench.includes("const filled = validSubscriptionLink(link);"));
  assert.ok(!workbench.includes("尚未生成"), "the read-only status row is replaced by the field");
  // The payload carries the link for node items only.
  assert.ok(admin.includes('...(it.service === "rocket" ? { subscriptionLinks: (it.subscriptionLinks || "").trim() } : {}),'));
  // The client-side gate mirrors the server's and points at the field.
  assert.ok(admin.includes('const missing = editForm.items.find((it) => it.service === "rocket" && !validSubscriptionLink(it.subscriptionLinks));'));
  assert.ok(admin.includes('data.error === "subscription_link_required"'));
  assert.ok(admin.includes('data.error === "subscription_link_invalid"'));
});

test("a failed provisioning is announced, never swallowed", () => {
  assert.match(route, /if \(!result\.ok && result\.status === "failed"\) \{\s*try \{\s*await sendTelegramNotice\(/);
  assert.match(route, /console\.error\("\[node-provision\] telegram alert failed:"/);
  assert.match(route, /type: result\.ok \? "node_provisioned" : "node_provision_failed"/);
});

test("staff can jump to the panel landing page from the order", () => {
  // Customers no longer get a separate "查看套餐用量" entry: the subscription
  // link they are shown is that same landing page, so a second one only
  // repeated the same URL twice.
  for (const [name, source] of [["service centre", serviceCentre], ["account", account]]) {
    assert.doesNotMatch(source, /sub-usage-link/, name);
    assert.doesNotMatch(source, /查看套餐用量/, name);
  }
  assert.match(admin, /href=\{activeOrder\.nodeProvision\?\.subLink \|\| rocketSubscriptionUrl\(activeOrder\.orderId\)\}/);
});

test("the panel token is edited in the site settings and kept out of the environment and public payload", () => {
  assert.match(settingsPanel, /nodePanel\.apiToken/);
  assert.match(settingsPanel, /type: showPanelToken \? "text" : "password"/);
  assert.match(publicRoute, /publicSiteSettings\(await getSettings\(\)\)/);
  assert.doesNotMatch(envExample, /NODE_PANEL/);
  assert.equal(/[0-9a-f]{64}/.test(route + admin + settingsPanel), false, "no 64-hex token literal may sit in code");
});
