import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  clean,
  getAllOrders,
  getOrderEntryById,
  getUser,
  pushAdminActionLog,
  setOrderAt,
  setUser,
} from "../../_utils.js";
import {
  clearNetflixCodeLock,
  listNetflixCodeAccess,
  listNetflixMailEvents,
  netflixAccountHash,
  netflixCodeStoreConfigured,
} from "../../netflix-code/_store.js";

export const runtime = "nodejs";

function netflixItem(order) {
  return (Array.isArray(order?.items) ? order.items : []).find((item) => item?.service === "netflix") || null;
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

function compactMailEvents(rows) {
  const compacted = [];
  for (const row of rows) {
    const stamp = new Date(row.receivedAt || 0).getTime();
    const accountKey = row.accountHints[0] || `unmatched:${row.reason || row.subject || "mail"}`;
    const duplicate = compacted.find((entry) => entry.accountKey === accountKey
      && Math.abs(entry.stamp - stamp) <= 12 * 1000);
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
      accountHints: Array.from(new Set([...(duplicate.accountHints || []), ...(row.accountHints || [])])),
      orders: mergedOrders,
      matchedOrderCount: Math.max(duplicate.matchedOrderCount || 0, row.matchedOrderCount || 0),
    });
  }
  return compacted.map(({ accountKey, stamp, ...event }) => event);
}

export async function GET(request) {
  const auth = requireAdmin(request, "canViewOrders");
  if (auth.response) return auth.response;
  const orders = (await getAllOrders()).filter((order) => netflixItem(order));
  const userByEmail = new Map();
  const uniqueEmails = Array.from(new Set(orders.map((order) => String(order.email || "").trim().toLowerCase()).filter(Boolean)));
  const users = await Promise.all(uniqueEmails.map(async (email) => [email, await getUser(email)]));
  for (const [email, user] of users) userByEmail.set(email, user);
  const byHash = new Map();
  const orderControls = new Map();
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
  }
  const accessRows = await listNetflixCodeAccess({ limit: 120 });
  const access = accessRows.map((entry) => ({
    id: entry.id,
    orderId: entry.orderId,
    userEmail: entry.userEmail || "",
    accountEmail: entry.accountEmail || entry.accountHint || "",
    outcome: entry.outcome,
    eventId: entry.eventId,
    createdAtBeijing: entry.createdAtBeijing,
  }));
  const accessedOrdersByEvent = new Map();
  for (const entry of accessRows) {
    if (!entry.eventId || !entry.orderId) continue;
    if (!accessedOrdersByEvent.has(entry.eventId)) accessedOrdersByEvent.set(entry.eventId, new Set());
    accessedOrdersByEvent.get(entry.eventId).add(entry.orderId);
  }
  const eventRows = (await listNetflixMailEvents({ limit: 80 })).map((event) => {
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
      preview: event.preview,
      accountHints: operationalAccountHints(event.accountHints),
      matchedOrderCount: matchedOrders.length,
      orders: exactOrders.length ? exactOrders : matchedOrders.length === 1 ? matchedOrders : [],
    };
  });
  const events = compactMailEvents(eventRows).slice(0, 40);
  return Response.json({
    ok: true,
    configured: netflixCodeStoreConfigured() && String(process.env.NETFLIX_EMAIL_INGEST_SECRET || "").length >= 32,
    inboxAddress: process.env.NETFLIX_INBOX_ADDRESS || "netflix@codes.liumeiti.vip",
    events,
    access,
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
