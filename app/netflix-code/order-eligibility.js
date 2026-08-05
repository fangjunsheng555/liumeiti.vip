import { isNetflixOrderItem } from "../lib/netflix-delivery.js";

export function hasNetflixService(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items.some((item, index) => isNetflixOrderItem(order, item, index))
    || (!items.length && isNetflixOrderItem(order, order, 0));
}

export function eligibleNetflixCodeOrder(order) {
  return hasNetflixService(order)
    && ["received", "completed"].includes(order?.status)
    && order?.netflixSelfServiceEnabled === true
    && order?.expiry?.expired !== true;
}
