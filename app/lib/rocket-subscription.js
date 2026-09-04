// A node order has one customer-facing URL: the plain subscription address,
// which the panel serves as a landing page. Opened in a browser it shows the
// plan, the traffic used and the per-client import buttons, and pasted into a
// client it works as a subscription. That is why nothing here hands out a
// `?format=clash` variant any more — the plain link covers both uses, and a
// second link only gave customers a way to import the wrong one.
//
// The authoritative value comes from the panel itself (the `subLink` on its
// user record), recorded on the order when it is provisioned. The builder
// below is the fallback for when that value is missing: an order completed
// before provisioning existed, or one whose provisioning has not succeeded
// yet. The panel composes the same URL from its own host setting, so the two
// agree unless that setting changes.
const SUBSCRIPTION_BASE = "https://hk.joinvip.vip:2056/sub/";

export function rocketSubscriptionUrl(orderId) {
  // An order number is a string. Coercing anything else would build a link to
  // "[object Object]" or "0" that looks valid and resolves to nothing.
  if (typeof orderId !== "string") return "";
  const id = orderId.trim().replace(/\s+/g, "");
  return id ? `${SUBSCRIPTION_BASE}${encodeURIComponent(id)}` : "";
}

// Normalize whatever an order happens to carry. Orders written before the
// panel became the source of truth stored a `?format=clash` URL, and older
// ones a { shadowrocket, clash } pair; every shape resolves to the plain
// landing URL so one customer never sees a different link from another.
export function readRocketSubscriptionUrl(value) {
  const plain = (url) => {
    // Only a string can be an address. Coercing a number would turn a
    // malformed record into a link to "5".
    if (typeof url !== "string") return "";
    const text = url.trim();
    if (!text) return "";
    const cut = text.indexOf("?");
    return cut === -1 ? text : text.slice(0, cut);
  };
  if (typeof value === "string") return plain(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return plain(value.clash) || plain(value.shadowrocket);
}

// The link a customer may see, and the single place that decides it.
//
// Nothing is shown before the order is completed. Until staff finish it the
// panel user does not exist, so the URL resolves to an empty subscription —
// handing it out at checkout only produced "my subscription is empty" tickets.
export function customerSubscriptionUrl({ status, orderId, stored } = {}) {
  if (status !== "completed") return "";
  return readRocketSubscriptionUrl(stored) || rocketSubscriptionUrl(orderId);
}
