// One node order has one subscription URL, addressed by the order number and
// served in Clash format. Every supported client — Nextin and Shadowrocket on
// iOS, Clash Meta on Android, Clash Verge on desktop — reads that one list, so
// there is nothing else to hand a customer.
//
// This module is the single source for that URL. It used to be copied into six
// routes, half of which keyed the URL on the delivered account instead of the
// order number, so the same order could be shown two different links depending
// on which page the customer opened.
const SUBSCRIPTION_BASE = "https://hk.joinvip.vip:2056/sub/";

export function rocketSubscriptionUrl(orderId) {
  // An order number is a string. Coercing anything else would build a link to
  // "[object Object]" or "0" that looks valid and resolves to nothing.
  if (typeof orderId !== "string") return "";
  const id = orderId.trim().replace(/\s+/g, "");
  return id ? `${SUBSCRIPTION_BASE}${encodeURIComponent(id)}?format=clash` : "";
}

// The bare subscription path is also the panel's landing page for that user:
// it shows the plan, quota used and expiry. This is what "查看套餐用量" opens.
export function rocketUsagePageUrl(orderId) {
  if (typeof orderId !== "string") return "";
  const id = orderId.trim().replace(/\s+/g, "");
  return id ? `${SUBSCRIPTION_BASE}${encodeURIComponent(id)}` : "";
}

// Orders placed before this change stored a { shadowrocket, clash } pair. Read
// either shape so an existing order — and the completion email built from it —
// still shows the one link it should have.
export function readRocketSubscriptionUrl(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const clash = typeof value.clash === "string" ? value.clash.trim() : "";
  if (clash) return clash;
  const legacy = typeof value.shadowrocket === "string" ? value.shadowrocket.trim() : "";
  if (!legacy) return "";
  return legacy.includes("format=clash") ? legacy : `${legacy}${legacy.includes("?") ? "&" : "?"}format=clash`;
}
