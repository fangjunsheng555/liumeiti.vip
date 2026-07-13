import { adminSessionFromRequest, isRootAdminSession } from "../../_utils.js";
import { getSettings } from "../../_settings.js";
import { checkRedisHealth, readHealthStatuses } from "../../_health.js";

export const runtime = "nodejs";

const LABELS = {
  redis: "Redis 数据库",
  resend: "Resend 发信",
  resend_webhook: "Resend 回执",
  telegram_backup: "Telegram 备份",
  restore_drill: "恢复演练",
  usdt: "USDT 自动确认",
  renewal: "续费提醒",
  catalog: "商品目录",
};

function fallback(component, status, summary, metrics = {}) {
  return { component, status, summary, error: "", metrics, checkedAt: "", checkedAtBeijing: "", lastSuccessAt: "", lastSuccessAtBeijing: "" };
}

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const [redis, stored, settings] = await Promise.all([
    checkRedisHealth(),
    readHealthStatuses(),
    getSettings(),
  ]);
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
  if (!stored.telegram_backup) {
    stored.telegram_backup = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
      ? fallback("telegram_backup", "warning", "已配置，等待本周备份")
      : fallback("telegram_backup", "error", "Telegram 备份未配置");
  }
  if (!stored.restore_drill) stored.restore_drill = fallback("restore_drill", "warning", "等待首次备份演练");
  if (!stored.usdt) {
    stored.usdt = settings?.usdt?.autoConfirm
      ? fallback("usdt", "warning", "已开启，等待链上扫描")
      : fallback("usdt", "disabled", "自动确认未开启");
  }
  if (!stored.renewal) stored.renewal = fallback("renewal", "warning", "等待定时扫描");
  if (!stored.catalog) stored.catalog = fallback("catalog", "warning", "等待目录保存记录");

  const components = Object.keys(LABELS).map((key) => ({ ...stored[key], component: key, label: LABELS[key] }));
  const counts = components.reduce((out, item) => {
    out[item.status] = (out[item.status] || 0) + 1;
    return out;
  }, {});
  return Response.json({ ok: true, components, counts }, { headers: { "Cache-Control": "no-store" } });
}
