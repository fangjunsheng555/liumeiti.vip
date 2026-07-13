import {
  clean,
  formatBeijingTime,
  getOrderEntryById,
  getOrderOverviewRows,
  pushAdminActionLog,
  redisCmd,
  setOrderAt,
} from "./_utils.js";
import { getSettings } from "./_settings.js";
import { getOrderSla } from "../lib/order-sla.js";

const SCAN_LOCK_KEY = "lm:keeper:order-sla-scan";

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, reason: "telegram_not_configured" };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return { ok: response.ok, reason: response.ok ? "" : `telegram_${response.status}` };
  } catch (error) {
    return { ok: false, reason: clean(error?.message || "telegram_failed", 120) };
  }
}

function reminderText(order, sla) {
  const status = order.status === "awaiting_quote" ? "等待报价" : "等待处理";
  const owner = order.assignedStaffId
    ? `${order.assignedStaffUsername || "工作人员"} (#${order.assignedStaffId})`
    : "尚未认领";
  const siteUrl = String(process.env.SITE_URL || "https://www.liumeiti.vip").replace(/\/$/, "");
  return [
    "⏰ 订单处理已超时",
    `订单: ${clean(order.orderId, 80)}`,
    `服务: ${clean(order.serviceLabel || order.items?.map((item) => item?.label).filter(Boolean).join(" + ") || "未标注", 160)}`,
    `状态: ${status}`,
    `负责人: ${owner}`,
    `已超时: ${sla.overdueMinutes} 分钟`,
    `后台: ${siteUrl}/admin?order=${encodeURIComponent(order.orderId || "")}`,
  ].join("\n");
}

export async function scanOverdueOrderSla({ limit = 30 } = {}) {
  const locked = await redisCmd(["SET", SCAN_LOCK_KEY, "1", "NX", "EX", "240"]);
  if (locked !== "OK") return { ok: true, skipped: true, reason: "scan_locked" };
  const settings = await getSettings();
  if (settings.notify?.telegramEnabled === false) {
    return { ok: true, skipped: true, reason: "telegram_disabled" };
  }

  const rows = await getOrderOverviewRows();
  const candidates = rows
    .map((order) => ({ order, sla: getOrderSla(order) }))
    .filter(({ order, sla }) => sla.overdue && order.slaReminderKey !== sla.key)
    .sort((a, b) => b.sla.overdueMinutes - a.sla.overdueMinutes)
    .slice(0, Math.max(1, Math.min(100, Number(limit || 30))));

  let sent = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const entry = await getOrderEntryById(candidate.order.orderId);
    if (!entry?.order) continue;
    const order = entry.order;
    const sla = getOrderSla(order);
    if (!sla.overdue || order.slaReminderKey === sla.key) continue;
    const result = await sendTelegram(reminderText(order, sla));
    if (!result.ok) {
      failed += 1;
      continue;
    }
    const now = new Date();
    order.slaReminderKey = sla.key;
    order.slaReminderSentAt = now.toISOString();
    order.slaReminderSentAtBeijing = formatBeijingTime(now);
    order.slaReminderOverdueMinutes = sla.overdueMinutes;
    if (await setOrderAt(entry.index, order)) {
      sent += 1;
      await pushAdminActionLog({
        action: "order_sla_reminder",
        actor: { staffId: 0, staffUsername: "sla" },
        target: `order:${order.orderId}`,
        detail: { overdueMinutes: sla.overdueMinutes, assignedStaffId: order.assignedStaffId || 0 },
      });
    }
  }
  return { ok: failed === 0, scanned: candidates.length, sent, failed };
}

