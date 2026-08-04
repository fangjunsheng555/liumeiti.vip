import { adminSessionFromRequest, isRootAdminSession } from "../../_utils.js";
import { getSettingsStrict } from "../../_settings.js";
import { checkRedisHealth, readAllHealthHistoryWithDiagnostics, readHealthStatusesWithDiagnostics } from "../../_health.js";
import { pushServerConfiguration, readPushQueueStats } from "../../_push.js";
import { withApiTelemetry } from "../../_observability.js";

export const runtime = "nodejs";

const LABELS = {
  redis: "Redis 数据库",
  resend: "Resend 发信",
  resend_webhook: "Resend 回执",
  brevo: "Brevo 备用发信",
  brevo_webhook: "Brevo 回执",
  telegram_backup: "安全外部备份",
  restore_drill: "恢复演练",
  usdt: "USDT 自动确认",
  renewal: "续费提醒",
  catalog: "商品目录",
  api: "核心 API 服务",
  telegram: "Telegram 告警",
  job_runner: "任务运行器",
  order_transition: "订单恢复队列",
  quote_expiry: "报价到期任务",
  order_sla: "订单 SLA",
  after_sales_outbox: "售后 Outbox",
  marketing_queue: "营销派发队列",
  push: "浏览器 Push",
};

function fallback(component, status, summary, metrics = {}) {
  return {
    component,
    status,
    summary,
    error: "",
    metrics,
    checkedAt: "",
    checkedAtBeijing: "",
    lastSuccessAt: "",
    lastSuccessAtBeijing: "",
    lastFailureAt: "",
    lastFailureAtBeijing: "",
    stale: false,
  };
}

function brevoSmtpConfigured() {
  return Boolean(
    process.env.FALLBACK_SMTP_HOST
    && process.env.FALLBACK_SMTP_USER
    && process.env.FALLBACK_SMTP_PASS,
  );
}

function pushQueueMetrics(pushStats) {
  if (!pushStats?.ok) return {};
  const { ok, ...metrics } = pushStats;
  return metrics;
}

async function healthOverviewHandler(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let redis;
  let statusResult;
  let settings;
  let pushStats;
  let historyResult;
  try {
    [redis, statusResult, settings, pushStats, historyResult] = await Promise.all([
      checkRedisHealth(),
      readHealthStatusesWithDiagnostics(),
      getSettingsStrict(),
      readPushQueueStats(),
      readAllHealthHistoryWithDiagnostics(12),
    ]);
  } catch (error) {
    return Response.json({
      ok: false,
      error: String(error?.code || error?.message || "health_store_unavailable").slice(0, 160),
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const stored = statusResult.statuses;
  const statusDiagnostics = statusResult.diagnostics;
  const history = historyResult.history;
  const historyDiagnostics = historyResult.diagnostics;
  stored.redis = redis;

  if (!stored.resend) {
    stored.resend = process.env.RESEND_API_KEY
      ? fallback("resend", "warning", "已配置，等待发送结果")
      : fallback("resend", "error", "Resend API 未配置");
  }
  if (!stored.resend_webhook) {
    stored.resend_webhook = process.env.RESEND_WEBHOOK_SECRET
      ? fallback("resend_webhook", "warning", "已配置，等待投递回执")
      : fallback("resend_webhook", "error", "Webhook 签名密钥未配置");
  }
  if (!stored.brevo) {
    stored.brevo = brevoSmtpConfigured()
      ? fallback("brevo", "warning", "备用通道已配置，等待发送验证")
      : fallback("brevo", "error", "Brevo 备用通道未完整配置");
  }
  if (!stored.brevo_webhook) {
    stored.brevo_webhook = process.env.BREVO_WEBHOOK_TOKEN
      ? fallback("brevo_webhook", "warning", "已配置，等待投递回执")
      : fallback("brevo_webhook", "error", "Brevo 回执令牌未配置");
  }
  stored.telegram_backup = fallback("telegram_backup", "disabled", "安全对象存储未配置，自动备份已停用");
  stored.restore_drill = fallback("restore_drill", "disabled", "没有完整的安全快照，恢复演练已停用");
  if (!stored.usdt) {
    stored.usdt = settings?.usdt?.autoConfirm
      ? fallback("usdt", "warning", "已开启，等待链上扫描")
      : fallback("usdt", "disabled", "自动确认未开启");
  }
  if (!stored.renewal) stored.renewal = fallback("renewal", "warning", "等待定时扫描");
  if (!stored.catalog) stored.catalog = fallback("catalog", "warning", "等待目录保存记录");
  if (!stored.api) stored.api = fallback("api", "warning", "等待首批核心 API 指标");
  if (!stored.telegram) {
    stored.telegram = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
      ? fallback("telegram", "warning", "告警通道已配置，等待首次投递")
      : fallback("telegram", "disabled", "Telegram 告警未配置");
  }
  if (!stored.job_runner) stored.job_runner = fallback("job_runner", "warning", "等待首次维护任务");
  if (!stored.order_transition) stored.order_transition = fallback("order_transition", "warning", "等待首次订单恢复扫描");
  if (!stored.quote_expiry) stored.quote_expiry = fallback("quote_expiry", "warning", "等待首次报价到期扫描");
  if (!stored.order_sla) stored.order_sla = fallback("order_sla", "warning", "等待首次订单 SLA 扫描");
  if (!stored.after_sales_outbox) stored.after_sales_outbox = fallback("after_sales_outbox", "warning", "等待首次售后副作用扫描");
  if (!stored.marketing_queue) stored.marketing_queue = fallback("marketing_queue", "warning", "等待首次营销队列扫描");
  const pushConfig = pushServerConfiguration();
  const pushMetrics = pushQueueMetrics(pushStats);
  if (!pushConfig.enabled) {
    stored.push = fallback("push", "disabled", "浏览器 Push 未启用", pushMetrics);
  } else if (!pushConfig.configured) {
    stored.push = fallback("push", "error", "浏览器 Push 配置不完整", pushMetrics);
    stored.push.error = "push_not_configured";
  } else if (!pushStats?.ok) {
    stored.push = fallback("push", "error", "Push 队列统计读取失败");
    stored.push.error = pushStats?.error || "push_queue_stats_unavailable";
  } else if (!stored.push) {
    stored.push = fallback("push", "warning", "等待首次 Push 维护任务", pushMetrics);
  } else {
    stored.push = { ...stored.push, metrics: { ...(stored.push.metrics || {}), ...pushMetrics } };
  }

  const components = Object.keys(LABELS).map((key) => ({ ...stored[key], component: key, label: LABELS[key] }));
  const counts = components.reduce((out, item) => {
    out[item.status] = (out[item.status] || 0) + 1;
    return out;
  }, {});
  return Response.json({
    ok: true,
    components,
    counts,
    history,
    statusDiagnostics,
    historyDiagnostics,
    generatedAt: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withApiTelemetry("admin_health", healthOverviewHandler);
