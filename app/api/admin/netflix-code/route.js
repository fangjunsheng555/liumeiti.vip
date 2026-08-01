import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  clean,
  formatBeijingTime,
  getAllOrders,
  getOrderEntryById,
  getUser,
  pushAdminActionLog,
  setOrderAt,
  setUser,
} from "../../_utils.js";
import {
  clearNetflixCodeLock,
  deleteNetflixCodeAccessRecords,
  deleteNetflixMailEvents,
  latestNetflixMailReceipts,
  listNetflixCodeAccess,
  listNetflixMailEvents,
  netflixAccountHash,
  netflixCodeStoreConfigured,
} from "../../netflix-code/_store.js";
import {
  compactNetflixMailEvents,
  filterNetflixAccessRecords,
  filterNetflixMailEvents,
  normalizeNetflixRecordQuery,
} from "./_records.js";

export const runtime = "nodejs";

function netflixItem(order) {
  return (Array.isArray(order?.items) ? order.items : []).find((item) => item?.service === "netflix")
    || (String(order?.service || "").toLowerCase() === "netflix" ? order : null);
}

function accountFor(order) {
  const item = netflixItem(order);
  return String(item?.staffAccount || item?.account || order?.staffAccount || order?.account || "").trim().toLowerCase();
}

function requireAdmin(request, permission) {
  const session = adminSessionFromRequest(request);
  if (!session) return { response: Response.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  const permissions = adminPermissionProfile(session);
  if (!permissions[permission]) return { response: Response.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  return { session, permissions };
}

function operationalAccountHints(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter((value) => {
    const domain = String(value || "").split("@")[1]?.toLowerCase() || "";
    return domain
      && domain !== "codes.liumeiti.vip"
      && !domain.endsWith(".codes.liumeiti.vip")
      && domain !== "amazonses.com"
      && !domain.endsWith(".amazonses.com");
  })));
}

export async function GET(request) {
  const auth = requireAdmin(request, "canViewOrders");
  if (auth.response) return auth.response;
  const query = normalizeNetflixRecordQuery(new URL(request.url).searchParams.get("q"));
  const queryHash = query.includes("@") ? netflixAccountHash(query) : "";
  const orders = (await getAllOrders()).filter((order) => netflixItem(order));
  const userByEmail = new Map();
  const uniqueEmails = Array.from(new Set(orders.map((order) => String(order.email || "").trim().toLowerCase()).filter(Boolean)));
  const users = await Promise.all(uniqueEmails.map(async (email) => [email, await getUser(email)]));
  for (const [email, user] of users) userByEmail.set(email, user);
  const byHash = new Map();
  const orderControls = new Map();
  const accountByOrderId = new Map();
  for (const order of orders) {
    const account = accountFor(order);
    if (!account) continue;
    const hash = netflixAccountHash(account);
    if (!byHash.has(hash)) byHash.set(hash, []);
    const buyerEmail = String(order.email || "").trim().toLowerCase();
    const user = userByEmail.get(buyerEmail) || null;
    const control = {
      orderId: order.orderId,
      email: buyerEmail,
      status: order.status || "received",
      serviceLabel: order.serviceLabel || "Netflix",
      enabled: order.netflixSelfServiceEnabled !== false,
      userRegistered: Boolean(user),
      userEnabled: !user?.netflixSelfServiceDisabled,
    };
    byHash.get(hash).push(control);
    orderControls.set(order.orderId, control);
    accountByOrderId.set(order.orderId, account);
  }
  const receipts = await latestNetflixMailReceipts(Array.from(byHash.keys()));
  const accountRows = [];
  const seenAccounts = new Set();
  for (const account of accountByOrderId.values()) {
    if (seenAccounts.has(account)) continue;
    seenAccounts.add(account);
    const hash = netflixAccountHash(account);
    const controls = byHash.get(hash) || [];
    if (query && !(
      account.includes(query)
      || controls.some((control) => control.orderId.toLowerCase().includes(query) || control.email.includes(query))
    )) continue;
    const lastMailAt = Number(receipts[hash] || 0);
    accountRows.push({
      account,
      orderCount: controls.length,
      lastMailAt: lastMailAt ? new Date(lastMailAt).toISOString() : "",
      lastMailAtBeijing: lastMailAt ? formatBeijingTime(new Date(lastMailAt)) : "",
    });
  }
  accountRows.sort((left, right) => (Date.parse(left.lastMailAt) || 0) - (Date.parse(right.lastMailAt) || 0));

  const accessRows = await listNetflixCodeAccess({ limit: 200 });
  const access = filterNetflixAccessRecords(accessRows.map((entry) => ({
    id: entry.id,
    orderId: entry.orderId,
    userEmail: entry.userEmail || "",
    accountEmail: entry.accountEmail || entry.accountHint || "",
    outcome: entry.outcome,
    eventId: entry.eventId,
    createdAtBeijing: entry.createdAtBeijing,
  })), query);
  const accessedOrdersByEvent = new Map();
  for (const entry of accessRows) {
    if (!entry.eventId || !entry.orderId) continue;
    if (!accessedOrdersByEvent.has(entry.eventId)) accessedOrdersByEvent.set(entry.eventId, new Set());
    accessedOrdersByEvent.get(entry.eventId).add(entry.orderId);
  }
  const eventRows = (await listNetflixMailEvents({ limit: 100 })).map((event) => {
    const matchedAccountHashes = Array.from(event.accountHashes || [])
      .filter((hash) => byHash.has(hash))
      .sort();
    const matchedOrders = Array.from(new Set((event.accountHashes || [])
      .flatMap((hash) => byHash.get(hash) || [])
      .map((order) => order.orderId)))
      .map((orderId) => orderControls.get(orderId))
      .filter(Boolean);
    const accessedOrderIds = accessedOrdersByEvent.get(event.eventId) || new Set();
    const exactOrders = Array.from(accessedOrderIds)
      .map((orderId) => orderControls.get(orderId))
      .filter(Boolean);
    return {
      eventId: event.eventId,
      accepted: event.accepted,
      kind: event.kind,
      reason: event.reason,
      template: event.template,
      language: event.language,
      receivedAt: event.receivedAt,
      receivedAtBeijing: event.receivedAtBeijing,
      expiresAt: event.expiresAt,
      sender: event.sender,
      subject: event.subject,
      accountKey: matchedAccountHashes.length
        ? `matched:${matchedAccountHashes.join("|")}`
        : `unmatched:${Array.from(event.accountHashes || []).sort().join("|")}`,
      accountHints: operationalAccountHints(event.accountHints),
      searchHashes: Array.from(event.accountHashes || []),
      searchValues: matchedOrders.flatMap((order) => [
        order.orderId,
        order.email,
        accountByOrderId.get(order.orderId),
      ]),
      matchedOrderCount: matchedOrders.length,
      orders: exactOrders.length ? exactOrders : matchedOrders.length === 1 ? matchedOrders : [],
    };
  });
  const compactedEvents = compactNetflixMailEvents(eventRows);
  const recentAcceptedCount = compactedEvents.filter((event) => event.accepted).length;
  const events = filterNetflixMailEvents(compactedEvents, query, queryHash)
    .slice(0, 40)
    .map(({ accountKey, stamp, searchHashes, searchValues, ...event }) => event);
  return Response.json({
    ok: true,
    configured: netflixCodeStoreConfigured() && String(process.env.NETFLIX_EMAIL_INGEST_SECRET || "").length >= 32,
    inboxAddress: process.env.NETFLIX_INBOX_ADDRESS || "netflix@codes.liumeiti.vip",
    events,
    access,
    accounts: accountRows.slice(0, 100),
    recentAcceptedCount,
    searchQuery: query,
    orders: Array.from(orderControls.values()),
    orderCount: orders.length,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request) {
  const auth = requireAdmin(request, "canEditOrders");
  if (auth.response) return auth.response;
  let body = {};
  try { body = await request.json(); } catch {}
  const action = clean(body.action, 40);
  const orderId = clean(body.orderId, 80).replace(/\s+/g, "").toUpperCase();
  const entry = orderId ? await getOrderEntryById(orderId) : null;
  if (["toggle_order", "toggle_user", "clear_lock"].includes(action) && !entry?.order) {
    return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  }
  const actor = adminActorFromSession(auth.session);

  if (action === "delete_mail_records") {
    const result = await deleteNetflixMailEvents(body.recordIds);
    if (!result.ok) return Response.json({ ok: false, error: "delete_failed" }, { status: 500 });
    await pushAdminActionLog({
      action: "netflix_mail_records_delete",
      actor,
      target: `netflix-mail:${clean(body.recordIds?.[0], 80)}`,
      detail: { deleted: result.deleted },
    });
    return Response.json({ ok: true, deleted: result.deleted });
  }

  if (action === "delete_access_records") {
    const result = await deleteNetflixCodeAccessRecords(body.recordIds);
    if (!result.ok) return Response.json({ ok: false, error: "delete_failed" }, { status: 500 });
    await pushAdminActionLog({
      action: "netflix_access_records_delete",
      actor,
      target: `netflix-access:${clean(body.recordIds?.[0], 80)}`,
      detail: { deleted: result.deleted },
    });
    return Response.json({ ok: true, deleted: result.deleted });
  }

  if (action === "toggle_order") {
    if (!netflixItem(entry.order)) return Response.json({ ok: false, error: "netflix_order_required" }, { status: 400 });
    entry.order.netflixSelfServiceEnabled = body.enabled !== false;
    if (!await setOrderAt(entry.index, entry.order)) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
    await pushAdminActionLog({ action: "netflix_code_order_toggle", actor, target: `order:${orderId}`, detail: { enabled: entry.order.netflixSelfServiceEnabled } });
    return Response.json({ ok: true, enabled: entry.order.netflixSelfServiceEnabled });
  }

  if (action === "toggle_user") {
    const email = String(entry.order.email || "").toLowerCase();
    const user = await getUser(email);
    if (!user) return Response.json({ ok: false, error: "user_not_found" }, { status: 404 });
    user.netflixSelfServiceDisabled = body.enabled === false;
    if (!await setUser(email, user)) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
    await pushAdminActionLog({ action: "netflix_code_user_toggle", actor, target: `user:${email}`, detail: { enabled: !user.netflixSelfServiceDisabled } });
    return Response.json({ ok: true, enabled: !user.netflixSelfServiceDisabled });
  }

  if (action === "clear_lock") {
    await clearNetflixCodeLock(orderId);
    await pushAdminActionLog({ action: "netflix_code_lock_clear", actor, target: `order:${orderId}`, detail: {} });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "invalid_action" }, { status: 400 });
}
