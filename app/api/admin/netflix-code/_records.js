function unique(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

export function normalizeNetflixRecordQuery(value) {
  return String(value || "").trim().toLowerCase().slice(0, 200);
}

export function compactNetflixMailEvents(rows) {
  const compacted = [];
  for (const source of (Array.isArray(rows) ? rows : [])) {
    const row = {
      ...source,
      eventIds: unique(source.eventIds?.length ? source.eventIds : [source.eventId]),
      searchValues: unique(source.searchValues),
      searchHashes: unique(source.searchHashes),
    };
    const stamp = new Date(row.receivedAt || 0).getTime();
    const accountKey = row.accountKey || row.accountHints?.[0] || `unmatched:${row.reason || row.subject || "mail"}`;
    const duplicate = compacted.find((entry) => entry.accountKey === accountKey
      && Math.abs(entry.stamp - stamp) <= 15 * 1000);
    if (!duplicate) {
      compacted.push({ ...row, accountKey, stamp, duplicateCount: 1 });
      continue;
    }
    const preferred = row.accepted && !duplicate.accepted ? row : duplicate;
    const mergedOrders = Array.from(new Map([
      ...(duplicate.orders || []),
      ...(row.orders || []),
    ].map((order) => [order.orderId, order])).values());
    Object.assign(duplicate, preferred, {
      accountKey,
      stamp: preferred === row ? stamp : duplicate.stamp,
      duplicateCount: duplicate.duplicateCount + 1,
      eventIds: unique([...(duplicate.eventIds || []), ...(row.eventIds || [])]),
      accountHints: unique([...(duplicate.accountHints || []), ...(row.accountHints || [])]),
      searchValues: unique([...(duplicate.searchValues || []), ...(row.searchValues || [])]),
      searchHashes: unique([...(duplicate.searchHashes || []), ...(row.searchHashes || [])]),
      orders: mergedOrders,
      matchedOrderCount: Math.max(duplicate.matchedOrderCount || 0, row.matchedOrderCount || 0),
    });
  }
  return compacted;
}

export function filterNetflixMailEvents(rows, query, queryHash = "") {
  const normalized = normalizeNetflixRecordQuery(query);
  if (!normalized) return rows;
  return (Array.isArray(rows) ? rows : []).filter((event) => (
    (queryHash && (event.searchHashes || []).includes(queryHash))
    || (event.searchValues || []).some((value) => normalizeNetflixRecordQuery(value).includes(normalized))
    || (event.accountHints || []).some((value) => normalizeNetflixRecordQuery(value).includes(normalized))
  ));
}

export function filterNetflixAccessRecords(rows, query) {
  const normalized = normalizeNetflixRecordQuery(query);
  if (!normalized) return rows;
  return (Array.isArray(rows) ? rows : []).filter((entry) => [
    entry.userEmail,
    entry.accountEmail,
    entry.orderId,
  ].some((value) => normalizeNetflixRecordQuery(value).includes(normalized)));
}
