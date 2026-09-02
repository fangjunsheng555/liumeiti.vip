import { clean } from "./_utils.js";
import { rocketSubscriptionUrl } from "../lib/rocket-subscription.js";
import { NODE_PANEL_PLAN_IDS, SETTINGS_DEFAULTS } from "../lib/settings-defaults.js";

// Client for the node panel's external API (m-ui, web/public_api.go). A node
// order that staff mark completed becomes a panel user named after the order
// number with the matching plan applied, so the subscription URL the site has
// already handed the customer starts serving traffic without anyone opening
// the panel.
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
  if (result.status === "skipped") return result.error === "panel_not_configured" ? "站点设置未开启面板自动开通" : "非机场节点订单";
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
