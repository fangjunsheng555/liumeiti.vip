import { orderExpirySummary } from "../lib/order-expiry.js";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validRecipientEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 200;
}

function orderItems(order) {
  if (Array.isArray(order?.items) && order.items.length) return order.items;
  return order?.service ? [{ service: order.service, cycle: order.cycle || "" }] : [];
}

function serviceIsCurrent(order, service, now) {
  if (order.status === "received") return true;
  if (order.status !== "completed") return false;
  const expiry = orderExpirySummary(order, now);
  if (!expiry) return true;
  const matching = expiry.items.filter((item) => item.service === service);
  return matching.length === 0 || matching.some((item) => item.daysLeft >= 0);
}

export function buildServiceNoticeAudience(orders, service, now = Date.now()) {
  const serviceKey = String(service || "").trim();
  if (!serviceKey) return [];
  const recipients = new Map();

  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order || order.deleted || !["received", "completed"].includes(order.status)) continue;
    if (!orderItems(order).some((item) => String(item?.service || "") === serviceKey)) continue;
    if (!serviceIsCurrent(order, serviceKey, now)) continue;
    const email = normalizeEmail(order.email || order.userEmail);
    if (!validRecipientEmail(email)) continue;
    const timestamp = new Date(order.completedAt || order.createdAt || 0).getTime() || 0;
    const current = recipients.get(email);
    const orderId = String(order.orderId || "").trim();
    if (!current) {
      recipients.set(email, {
        email,
        locale: order.locale === "en" ? "en" : "zh",
        latestOrderId: orderId,
        orderIds: orderId ? [orderId] : [],
        timestamp,
      });
      continue;
    }
    if (orderId && !current.orderIds.includes(orderId)) current.orderIds.push(orderId);
    if (timestamp >= current.timestamp) {
      current.locale = order.locale === "en" ? "en" : "zh";
      current.latestOrderId = orderId || current.latestOrderId;
      current.timestamp = timestamp;
    }
  }

  return Array.from(recipients.values())
    .map(({ timestamp, ...recipient }) => recipient)
    .sort((a, b) => a.email.localeCompare(b.email));
}

export function serviceNoticeAudienceSummary(audience) {
  const rows = Array.isArray(audience) ? audience : [];
  return {
    total: rows.length,
    zh: rows.filter((item) => item.locale !== "en").length,
    en: rows.filter((item) => item.locale === "en").length,
  };
}
