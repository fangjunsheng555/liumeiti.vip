import { NETFLIX_DUAL_DELIVERY_WINDOW_MS } from "./_store.js";

// The second forwarding path may legitimately arrive at the full 120-second
// duplicate-delivery boundary. Keep one complete six-second browser poll plus
// transport/scheduling headroom before turning a rejected copy into the final
// "unrecognized" response.
export const REJECTED_SIBLING_POLL_ALLOWANCE_MS = 10 * 1000;
export const REJECTED_SIBLING_GRACE_MS = NETFLIX_DUAL_DELIVERY_WINDOW_MS
  + REJECTED_SIBLING_POLL_ALLOWANCE_MS;

export function shouldAwaitAcceptedSibling(mailState, now = Date.now()) {
  if (mailState?.state !== "rejected") return false;
  const receivedAt = new Date(mailState.receivedAt || 0).getTime();
  return Number.isFinite(receivedAt)
    && receivedAt > 0
    && now - receivedAt >= 0
    && now - receivedAt < REJECTED_SIBLING_GRACE_MS;
}
