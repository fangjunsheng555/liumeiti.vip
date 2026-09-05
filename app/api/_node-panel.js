import { clean } from "./_utils.js";
import { readRocketSubscriptionUrl, rocketSubscriptionUrl, validSubscriptionLink } from "../lib/rocket-subscription.js";
import { NODE_PANEL_PLAN_IDS, SETTINGS_DEFAULTS } from "../lib/settings-defaults.js";

// Client for the node panel's external API (m-ui, web/public_api.go). A node
// order that staff mark completed becomes a panel user named after the order
// number with the matching plan applied, and the subscription URL the panel
// issues for that user is what the customer is then shown — nobody opens the
// panel for a routine sale.
//
// Configuration lives in the site settings (站点设置 → 机场节点面板), not in
// the environment: the token is rotated from the panel now and then, and staff
// change it in the same place they read everything else. It is administrator-
// equivalent, stays server-side, and nothing here logs it or echoes it back.

const REQUEST_TIMEOUT_MS = 10000;

export function nodePanelConfigFromSettings(settings) {
  const section = settings?.nodePanel && typeof settings.nodePanel === "object" ? settings.nodePanel : {};
  const defaults = SETTINGS_DEFAULTS.nodePanel;
  const token = typeof section.apiToken === "string" ? section.apiToken.trim() : "";
  const base = (typeof section.apiBase === "string" && section.apiBase.trim() ? section.apiBase.trim() : defaults.apiBase).replace(/\/+$/, "");
  const enabled = section.enabled === true;
  const planNames = Object.fromEntries(NODE_PANEL_PLAN_IDS.map((id) => {
    const name = section.planNames?.[id];
    return [id, typeof name === "string" && name.trim() ? name.trim() : defaults.planNames[id]];
  }));
  return { enabled, token, base, planNames, configured: enabled && Boolean(token && base) };
}

// The plan id lives on the item as `plan` (and historically `rocketPlan`).
export function panelPlanForItem(item, planNames) {
  const id = String(item?.plan || item?.rocketPlan || "").trim();
  if (!id) return { id: "", name: "" };
  const name = planNames && typeof planNames === "object" ? String(planNames[id] || "").trim() : "";
  return { id, name };
}

export function nodeItemsOf(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items.filter((item) => item?.service === "rocket");
}

// The first node item that would have no usable subscription link once the
// submitted item edits are applied — the link is taken from the edit when one
// is submitted, else from what the item already holds. A completion is refused
// while this returns anything: nothing is minted at completion any more, since
// an address the site guessed was exactly what produced dead links.
export function missingNodeSubscriptionLink(order, itemUpdates = []) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const updates = new Map();
  for (const update of Array.isArray(itemUpdates) ? itemUpdates : []) {
    const index = Number(update?.index);
    if (Number.isInteger(index) && index >= 0) updates.set(index, update);
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.service !== "rocket") continue;
    const update = updates.get(index);
    const link = typeof update?.subscriptionLinks === "string"
      ? update.subscriptionLinks
      : readRocketSubscriptionUrl(item.subscriptionLinks);
    if (validSubscriptionLink(link)) continue;
    return { index, label: clean(item?.label || item?.service || `#${index + 1}`, 180) };
  }
  return null;
}

// A submitted link that is present but not a valid https address, whatever
// the order's status: it must never be saved, or the customer gets a dead link.
export function invalidNodeSubscriptionLinkUpdate(order, itemUpdates = []) {
  const items = Array.isArray(order?.items) ? order.items : [];
  for (const update of Array.isArray(itemUpdates) ? itemUpdates : []) {
    if (typeof update?.subscriptionLinks !== "string") continue;
    const text = update.subscriptionLinks.trim();
    if (!text || validSubscriptionLink(text)) continue;
    const index = Number(update.index);
    const item = Number.isInteger(index) ? items[index] : null;
    return { index, label: clean(item?.label || item?.service || `#${index + 1}`, 180) };
  }
  return null;
}

function classifyHttpFailure(status, body) {
  const message = clean(body && typeof body === "object" ? body.error : "", 160);
  if (status === 401) return "panel_unauthorized";
  if (status === 404) return "panel_not_found";
  if (status >= 500) return `panel_error_${status}`;
  return message ? `panel_rejected:${message}` : `panel_http_${status}`;
}

async function panelRequest(config, fetchImpl, method, path, body) {
  const url = `${config.base}${path}`;
  const init = {
    method,
    headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    const reason = error?.name === "TimeoutError" || error?.name === "AbortError" ? "panel_timeout" : "panel_unreachable";
    return { ok: false, status: 0, error: reason, detail: clean(error?.message, 120), body: null };
  }
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  if (!response.ok) {
    return { ok: false, status: response.status, error: classifyHttpFailure(response.status, parsed), body: parsed };
  }
  return { ok: true, status: response.status, body: parsed };
}

// Reachability probe. `/ping` needs the token like every other route, so a
// success proves three things at once: the panel answers, its external API is
// switched on, and the token the settings hold is the one it accepts. Nothing
// is created or changed, so this is safe to run on a schedule and by hand.
export async function checkNodePanel({ config, fetchImpl = globalThis.fetch } = {}) {
  const startedAt = Date.now();
  if (!config?.enabled) return { ok: false, status: "disabled", error: "panel_disabled", latencyMs: 0 };
  if (!config.configured) return { ok: false, status: "failed", error: "panel_not_configured", latencyMs: 0 };
  const ping = await panelRequest(config, fetchImpl, "GET", "/ping");
  const latencyMs = Date.now() - startedAt;
  if (!ping.ok) {
    return { ok: false, status: "failed", error: ping.error, detail: ping.detail || "", latencyMs };
  }
  // A reachable host that answers something other than the panel — a proxy
  // error page, a captive portal — must not read as healthy.
  if (ping.body?.ok !== true) {
    return { ok: false, status: "failed", error: "panel_unexpected_response", latencyMs };
  }
  return {
    ok: true,
    status: "ok",
    latencyMs,
    version: clean(ping.body.version, 40),
    role: clean(ping.body.role, 40),
  };
}

export function describeNodePanelCheck(result) {
  if (!result) return "";
  if (result.ok) return `面板可达${result.version ? ` · 版本 ${result.version}` : ""} · ${result.latencyMs}ms`;
  if (result.error === "panel_disabled") return "站点设置未开启面板开通功能";
  if (result.error === "panel_not_configured") return "未填写面板令牌";
  if (result.error === "panel_unexpected_response") return "该地址响应的不是节点面板";
  return describeNodeProvision({ status: "failed", error: result.error });
}

// Provision one node order. Idempotent on the panel side by construction: the
// user is looked up first, and an existing user — whether from an earlier
// attempt that died before the site recorded it, or from staff creating it by
// hand — is left exactly as it is. Only a missing user is created, with the
// plan applied in the same call.
export async function provisionNodeOrder(order, { config, fetchImpl = globalThis.fetch } = {}) {
  const orderId = String(order?.orderId || "").trim();
  const started = new Date();
  const base = { panelUser: orderId, at: started.toISOString() };
  if (!config?.configured) return { ...base, ok: false, status: "skipped", error: "panel_not_configured" };
  if (!orderId) return { ...base, ok: false, status: "failed", error: "order_id_missing" };

  const items = nodeItemsOf(order);
  if (!items.length) return { ...base, ok: false, status: "skipped", error: "no_node_item" };
  // One panel user per order. A cart with several node items would need one
  // user per item; that shape has never been sold, so treat it as an error
  // rather than silently provisioning only the first.
  if (items.length > 1) return { ...base, ok: false, status: "failed", error: "multiple_node_items" };

  const plan = panelPlanForItem(items[0], config.planNames);
  if (!plan.name) return { ...base, ok: false, status: "failed", error: plan.id ? `plan_unmapped:${plan.id}` : "plan_missing", plan: plan.id };

  const existing = await panelRequest(config, fetchImpl, "GET", `/users/${encodeURIComponent(orderId)}`);
  if (existing.ok) {
    return {
      ...base, ok: true, status: "done", existed: true, plan: plan.name,
      subLink: clean(existing.body?.subLink, 300) || rocketSubscriptionUrl(orderId),
      enabled: existing.body?.enabled !== false,
    };
  }
  if (existing.error !== "panel_not_found") {
    return { ...base, ok: false, status: "failed", error: existing.error, detail: existing.detail || "", plan: plan.name };
  }
  const created = await panelRequest(config, fetchImpl, "POST", "/users", {
    name: orderId,
    plan: plan.name,
    remark: `订单 ${orderId} · ${clean(items[0].label || items[0].planLabel || plan.id, 60)}`,
  });
  if (!created.ok) {
    // A racing attempt may have created the user between the two calls; the
    // panel reports that as a duplicate-name rejection. Read it back rather
    // than fail on what is, for the customer, a success.
    if (created.status === 400 && /已存在|exists|UNIQUE/i.test(String(created.body?.error || ""))) {
      const readBack = await panelRequest(config, fetchImpl, "GET", `/users/${encodeURIComponent(orderId)}`);
      if (readBack.ok) {
        return { ...base, ok: true, status: "done", existed: true, plan: plan.name, subLink: clean(readBack.body?.subLink, 300) || rocketSubscriptionUrl(orderId) };
      }
    }
    return { ...base, ok: false, status: "failed", error: created.error, detail: created.detail || "", plan: plan.name };
  }
  return {
    ...base, ok: true, status: "done", existed: false, plan: plan.name,
    subLink: clean(created.body?.subLink, 300) || rocketSubscriptionUrl(orderId),
    enabled: created.body?.enabled !== false,
  };
}

// Human-readable summary for staff surfaces. Never includes the token.
export function describeNodeProvision(result) {
  if (!result) return "";
  if (result.status === "done") return result.existed ? "面板已有该用户，未重复开通" : `已开通套餐 ${result.plan || ""}`.trim();
  if (result.status === "skipped") return result.error === "panel_not_configured" ? "站点设置未开启面板开通功能" : "非机场节点订单";
  const reasons = {
    panel_unauthorized: "面板令牌无效或外部 API 未开启",
    panel_unreachable: "无法连接面板",
    panel_timeout: "连接面板超时",
    multiple_node_items: "订单含多个节点商品，需人工开通",
    plan_missing: "订单缺少套餐信息",
    order_id_missing: "订单号缺失",
  };
  if (reasons[result.error]) return reasons[result.error];
  if (String(result.error || "").startsWith("plan_unmapped:")) return `套餐未映射到面板：${result.error.slice(14)}`;
  if (String(result.error || "").startsWith("panel_rejected:")) return `面板拒绝：${result.error.slice(15)}`;
  return `开通失败：${result.error || "unknown"}`;
}
