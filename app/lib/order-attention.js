function timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : 0;
}

function orderItems(source) {
  if (Array.isArray(source)) return source;
  return Array.isArray(source?.items) ? source.items : [];
}

export function getSpotifyPasswordAttention(source) {
  const items = orderItems(source);
  let pending = false;
  let latestUpdatedAt = 0;
  let latestUpdatedAtValue = "";
  let latestUpdatedAtBeijing = "";
  let hasCorrectionMetadata = false;

  for (const item of items) {
    if (item?.service !== "spotify") continue;
    const requestedAt = timestamp(item.passwordCorrectionRequestedAt);
    const updatedAt = timestamp(item.customerPasswordUpdatedAt);
    if (requestedAt || updatedAt) hasCorrectionMetadata = true;
    if (requestedAt && (!updatedAt || updatedAt < requestedAt)) pending = true;
    if (requestedAt && updatedAt >= requestedAt && updatedAt >= latestUpdatedAt) {
      latestUpdatedAt = updatedAt;
      latestUpdatedAtValue = item.customerPasswordUpdatedAt || "";
      latestUpdatedAtBeijing = item.customerPasswordUpdatedAtBeijing || "";
    }
  }

  return {
    pending: hasCorrectionMetadata ? pending : Boolean(source?.passwordCorrectionPending),
    updated: latestUpdatedAt > 0,
    updatedAt: latestUpdatedAtValue,
    updatedAtBeijing: latestUpdatedAtBeijing,
  };
}

export function hasPendingSpotifyPasswordCorrection(source) {
  return getSpotifyPasswordAttention(source).pending;
}
