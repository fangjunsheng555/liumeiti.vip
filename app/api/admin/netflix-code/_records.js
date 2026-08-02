function unique(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

export function normalizeNetflixRecordQuery(value) {
  return String(value || "").trim().toLowerCase().slice(0, 200);
}

export function compactNetflixMailEvents(rows) {
  // Every inbound delivery is an independent audit record.  Account and time
  // proximity are not sufficient evidence that two messages are duplicates:
  // Netflix can legitimately send different codes seconds apart.  Keep this
  // compatibility-named helper one-to-one so callers cannot accidentally make
  // one visible row delete several underlying messages.
  return (Array.isArray(rows) ? rows : []).map((source) => ({
    ...source,
    eventIds: source?.eventId ? [source.eventId] : [],
    searchValues: unique(source?.searchValues),
    searchHashes: unique(source?.searchHashes),
    duplicateCount: 1,
  }));
}

export function filterNetflixMailEvents(rows, query, queryHash = "") {
  const normalized = normalizeNetflixRecordQuery(query);
  if (!normalized) return rows;
  return (Array.isArray(rows) ? rows : []).filter((event) => (
    (queryHash && (event.searchHashes || []).includes(queryHash))
    || (event.searchValues || []).some((value) => normalizeNetflixRecordQuery(value).includes(normalized))
    || (event.accountEmails || []).some((value) => normalizeNetflixRecordQuery(value).includes(normalized))
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

export function netflixMailSearchValues(rows) {
  return unique((Array.isArray(rows) ? rows : []).flatMap((order) => [
    order?.orderId,
    order?.email,
    order?.deliveryEmail,
    order?.userEmail,
    order?.ownerEmail,
    order?.linkedUserEmail,
    order?.accountEmail,
  ]));
}
