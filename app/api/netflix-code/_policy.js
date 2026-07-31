export const REJECTED_SIBLING_GRACE_MS = 30 * 1000;

export function shouldAwaitAcceptedSibling(mailState, now = Date.now()) {
  if (mailState?.state !== "rejected") return false;
  const receivedAt = new Date(mailState.receivedAt || 0).getTime();
  return Number.isFinite(receivedAt)
    && receivedAt > 0
    && now - receivedAt >= 0
    && now - receivedAt < REJECTED_SIBLING_GRACE_MS;
}
