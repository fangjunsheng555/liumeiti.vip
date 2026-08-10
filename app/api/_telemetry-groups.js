// Keep this module dependency-free. Root instrumentation imports it in both
// Node and Edge builds, while the API observability helpers use the same list.
//
// This is deliberately an allowlist, not an inventory of every API route. The
// `all` metric series means "all routes listed below" so it must never be
// presented as a whole-site measurement.
export const MONITORED_API_GROUP_DEFINITIONS = Object.freeze([
  { name: "admin_after_sales", label: "售后管理", routes: [
    "/api/admin/after-sales",
    "/api/admin/after-sales/[ticketId]",
    "/api/admin/after-sales/notify-by-reference",
  ] },
  { name: "admin_catalog", label: "商品目录管理", routes: [
    "/api/admin/catalog",
    "/api/admin/catalog/rollback",
    "/api/admin/catalog/versions",
  ] },
  { name: "admin_health", label: "系统健康管理", routes: [
    "/api/admin/health",
    "/api/admin/health/metrics",
    "/api/admin/health/jobs",
    "/api/admin/health/queues",
    "/api/admin/health/incidents",
    "/api/admin/health/incidents/[id]",
    "/api/admin/health/traces/[orderId]",
  ] },
  { name: "admin_orders", label: "订单管理", routes: [
    "/api/admin/orders",
    "/api/admin/orders/[orderId]",
    "/api/admin/orders/batch",
  ] },
  { name: "after_sales", label: "用户售后", routes: ["/api/after-sales", "/api/after-sales/status"] },
  { name: "auth_account", label: "账户状态", routes: ["/api/auth/me"] },
  { name: "auth_login", label: "用户登录", routes: ["/api/auth/login"] },
  { name: "auth_logout", label: "用户登出", routes: ["/api/auth/login"] },
  { name: "auth_register", label: "用户注册", routes: ["/api/auth/register"] },
  { name: "cron_maintenance", label: "维护巡检", routes: ["/api/cron/maintenance"] },
  { name: "order_create", label: "订单创建", routes: ["/api/order"] },
  { name: "quote_order_create", label: "报价单创建", routes: ["/api/quote-orders"] },
  { name: "netflix_code", label: "Netflix 自助取码", routes: ["/api/netflix-code"] },
  { name: "netflix_mail_ingest", label: "Netflix 邮件入站", routes: ["/api/webhooks/netflix-email"] },
  { name: "cron_push", label: "Push 派发维护", routes: ["/api/cron/push"] },
  { name: "mail_preferences", label: "邮件偏好", routes: [
    "/api/account/email-preferences",
    "/api/email/preferences",
  ] },
  { name: "admin_marketing_campaign", label: "营销活动管理", routes: [
    "/api/admin/mail/campaign",
    "/api/admin/mail/campaigns",
    "/api/admin/mail/campaigns/[campaignId]",
    "/api/admin/mail/campaigns/[campaignId]/stats",
  ] },
  { name: "cron_marketing_campaign", label: "营销邮件派发", routes: ["/api/cron/marketing-campaign"] },
  { name: "marketing_click", label: "营销点击归因", routes: ["/api/marketing/click"] },
]);

export const MONITORED_API_GROUP_NAMES = Object.freeze(
  MONITORED_API_GROUP_DEFINITIONS.map((group) => group.name),
);

// Long-running schedulers, webhook ingestion and the health dashboard itself
// retain their own per-group telemetry, but must not feed the customer-facing
// API aggregate. Otherwise one expected 30-second maintenance request (or the
// dashboard reading that request) can manufacture both a P95 and a 5xx alert.
export const CORE_API_AGGREGATE_GROUP = "core";
export const BACKGROUND_API_GROUP_NAMES = Object.freeze([
  "admin_health",
  "cron_maintenance",
  "cron_push",
  "cron_marketing_campaign",
  "netflix_mail_ingest",
]);
const backgroundApiGroups = new Set(BACKGROUND_API_GROUP_NAMES);
export const BACKGROUND_API_GROUP_DEFINITIONS = Object.freeze(
  MONITORED_API_GROUP_DEFINITIONS.filter((group) => backgroundApiGroups.has(group.name)),
);
export const CORE_API_GROUP_DEFINITIONS = Object.freeze(
  MONITORED_API_GROUP_DEFINITIONS.filter((group) => !backgroundApiGroups.has(group.name)),
);
export const CORE_API_GROUP_NAMES = Object.freeze(
  CORE_API_GROUP_DEFINITIONS.map((group) => group.name),
);

const coreRouteCount = new Set(
  CORE_API_GROUP_DEFINITIONS.flatMap((group) => group.routes),
).size;

// These exclusions make the boundaries for this release explicit. They still
// retain their own business-level health and error handling; they simply do
// not contribute to the core API request/error/latency aggregate.
export const CORE_API_TELEMETRY_COVERAGE = Object.freeze({
  scope: "core_api",
  scopeLabel: "核心 API",
  aggregationPolicy: "interactive_allowlist",
  aggregateGroup: CORE_API_AGGREGATE_GROUP,
  groupCount: CORE_API_GROUP_DEFINITIONS.length,
  routeCount: coreRouteCount,
  groups: CORE_API_GROUP_DEFINITIONS,
  explicitExclusions: Object.freeze([
    {
      area: "后台任务、邮件入站与健康诊断",
      routes: BACKGROUND_API_GROUP_DEFINITIONS.flatMap((group) => group.routes),
      reason: "继续保留独立趋势，但不纳入交互 API 的错误率和延迟告警",
    },
    {
      area: "Push 账户端设置",
      routes: ["/api/auth/push/*"],
      reason: "认证边界路由本轮不纳入核心趋势；Push 派发维护已单独覆盖",
    },
    {
      area: "营销受众、预览与退订",
      routes: ["/api/admin/mail/audience", "/api/admin/mail/preview", "/api/email/unsubscribe"],
      reason: "敏感边界接口明确排除；活动排期、状态、归因与派发已覆盖",
    },
  ]),
});

function normalizedPart(value, fallback = "root") {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

export function monitoredApiRouteGroup(pathname, method = "") {
  const path = String(pathname || "").split("?")[0].replace(/\/+$/, "") || "/";
  if (!path.startsWith("/api/")) return "other";
  const parts = path.slice(5).split("/").filter(Boolean);
  if (!parts.length) return "api_root";
  const first = normalizedPart(parts[0]);
  const second = normalizedPart(parts[1]);
  const third = normalizedPart(parts[2]);

  // Exact release-critical routes are checked before the historical broad
  // grouping rules so unrelated routes never silently enter the allowlist.
  if (first === "netflix_code" && parts.length === 1) return "netflix_code";
  if (first === "webhooks" && second === "netflix_email" && parts.length === 2) return "netflix_mail_ingest";
  if (first === "cron" && second === "push" && parts.length === 2) return "cron_push";
  if (first === "account" && second === "email_preferences" && parts.length === 2) return "mail_preferences";
  if (first === "email" && second === "preferences" && parts.length === 2) return "mail_preferences";
  if (first === "admin" && second === "mail" && ["campaign", "campaigns"].includes(third)) return "admin_marketing_campaign";
  if (first === "cron" && second === "marketing_campaign" && parts.length === 2) return "cron_marketing_campaign";
  if (first === "marketing" && second === "click" && parts.length === 2) return "marketing_click";

  if (first === "after_sales" && parts.length === 1) return "after_sales";
  if (first === "order" && parts.length === 1) return "order_create";
  if (first === "quote_orders" && parts.length === 1) return "quote_order_create";
  if (first === "admin") return `admin_${second}`;
  if (first === "cron") return `cron_${second}`;
  if (first === "auth") {
    if (second === "me") return "auth_account";
    if (second === "login" && String(method || "").toUpperCase() === "DELETE") return "auth_logout";
    return `auth_${second}`;
  }
  return first;
}
