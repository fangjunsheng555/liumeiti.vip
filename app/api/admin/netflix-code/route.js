import {
  adminActorFromSession,
  adminPermissionProfile,
  adminSessionFromRequest,
  clean,
  formatBeijingTime,
  getAllOrders,
  getOrderListRevision,
  getOrderEntryById,
  pushAdminActionLog,
  redisCmd,
  redisPipeline,
  setOrderAt,
  setUser,
  USERS_KEY,
} from "../../_utils.js";
import {
  clearNetflixCodeLock,
  deleteNetflixCodeAccessRecords,
  deleteNetflixMailEvents,
  latestNetflixMailReceipts,
  listAllNetflixCodeAccess,
  listAllNetflixMailEvents,
  listNetflixCodeAccess,
  listNetflixMailEvents,
  netflixAccountHash,
  netflixCodeStoreConfigured,
  revealNetflixMailAccountEmails,
  revealNetflixMailResult,
} from "../../netflix-code/_store.js";
import { netflixOrderIdentity } from "../../netflix-code/_ownership.js";
import {
  compactNetflixMailEvents,
  filterNetflixAccessRecords,
  filterNetflixMailEvents,
  netflixMailSearchValues,
  normalizeNetflixRecordQuery,
} from "./_records.js";
import { readUserAuthState } from "../../_auth-session.js";
import { isNetflixOrderItem } from "../../../lib/netflix-delivery.js";

export const runtime = "nodejs";

const NETFLIX_ORDER_DIRECTORY_CACHE_KEY = "liumeiti:admin:netflix-order-directory:v1";

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function pipelineRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  return [];
}

function pipelineValue(entry) {
  return entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "result")
    ? entry.result
    : entry;
}

function netflixItemEntry(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const index = items.findIndex((item, itemIndex) => isNetflixOrderItem(order, item, itemIndex));
  if (index >= 0) return { item: items[index], index, fromItems: true };
  return !items.length && isNetflixOrderItem(order, order, 0)
    ? { item: order, index: -1, fromItems: false }
    : null;
}

function netflixItem(order) {
  return netflixItemEntry(order)?.item || null;
}

function accountFor(order) {
  const entry = netflixItemEntry(order);
  if (!entry) return "";
  const allowTopLevelFallback = !entry.fromItems || entry.index === 0;
  return String(entry.item?.staffAccount
    || entry.item?.account
    || (allowTopLevelFallback ? order?.staffAccount || order?.account : "")
    || "").trim().toLowerCase();
}

function directoryOrder(order) {
  const entry = netflixItemEntry(order);
  if (!entry) return null;
  const { item } = entry;
  const allowTopLevelFallback = !entry.fromItems || entry.index === 0;
  return {
    orderId: order.orderId,
    email: order.email,
    userEmail: order.userEmail,
    status: order.status,
    service: "netflix",
    serviceLabel: order.serviceLabel,
    netflixSelfServiceEnabled: order.netflixSelfServiceEnabled,
    netflixDeliveryMode: order.netflixDeliveryMode,
    staffAccount: item.staffAccount || (allowTopLevelFallback ? order.staffAccount || "" : ""),
    account: item.account || (allowTopLevelFallback ? order.account || "" : ""),
    items: [{
      service: "netflix",
      staffAccount: item.staffAccount || "",
      account: item.account || "",
    }],
  };
}

async function netflixOrdersFromDirectory() {
  const revision = await getOrderListRevision();
  const signature = revision
    ? `${revision.revision}:${revision.total}:${revision.latestOrderId}`
    : "";
  if (signature) {
    const cached = parseJson(await redisCmd(["GET", NETFLIX_ORDER_DIRECTORY_CACHE_KEY]));
    if (cached?.signature === signature && Array.isArray(cached.orders)) return cached.orders;
  }
  const orders = (await getAllOrders()).map(directoryOrder).filter(Boolean);
  if (signature) {
    // Use the POST pipeline endpoint so a large directory never lands in a
    // request URL (or exceeds intermediary URL limits).
    await redisPipeline([[
      "SET", NETFLIX_ORDER_DIRECTORY_CACHE_KEY, JSON.stringify({ signature, orders }),
      "EX", String(24 * 60 * 60),
    ]]);
  }
  return orders;
}

async function usersByEmail(emails) {
  const normalized = Array.from(new Set((Array.isArray(emails) ? emails : [])
    .map((email) => String(email || "").trim().toLowerCase())
    .filter(Boolean)));
  const users = new Map();
  for (let offset = 0; offset < normalized.length; offset += 200) {
    const batch = normalized.slice(offset, offset + 200);
    const rows = pipelineRows(await redisPipeline(batch.map((email) => ["GET", `${USERS_KEY}:${email}`])));
    batch.forEach((email, index) => users.set(email, parseJson(pipelineValue(rows[index]))));
  }
  return users;
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
  const params = new URL(request.url).searchParams;
  const query = normalizeNetflixRecordQuery(params.get("q"));
  const requestedScope = clean(params.get("scope"), 20).toLowerCase();
  const scope = ["mail", "access", "accounts"].includes(requestedScope) ? requestedScope : "mail";
  const queryHash = query.includes("@") ? netflixAccountHash(query) : "";
  const orders = await netflixOrdersFromDirectory();
  const uniqueEmails = Array.from(new Set(orders
    .map((order) => netflixOrderIdentity(order).ownerEmail)
    .filter(Boolean)));
  const userByEmail = await usersByEmail(uniqueEmails);
  const byHash = new Map();
  const accountByHash = new Map();
  const orderControls = new Map();
  const accountByOrderId = new Map();
  for (const order of orders) {
    const account = accountFor(order);
    const { ownerEmail, deliveryEmail, linkedUserEmail } = netflixOrderIdentity(order);
    const user = userByEmail.get(ownerEmail) || null;
    const control = {
      orderId: order.orderId,
      // Keep `email` for existing panel consumers, but make its delivery-only
      // meaning explicit and never use it as the user-control principal.
      email: deliveryEmail,
      deliveryEmail,
      ownerEmail,
      linkedUserEmail,
      status: order.status || "received",
      serviceLabel: order.serviceLabel || "Netflix",
      account,
      deliveryMode: order.netflixDeliveryMode === "self_service"
        || order.netflixDeliveryMode === undefined
        || order.netflixDeliveryMode === null
        || order.netflixDeliveryMode === ""
        ? "self_service"
        : "password",
      enabled: order.netflixSelfServiceEnabled !== false,
      userRegistered: Boolean(user),
      userEnabled: !user?.netflixSelfServiceDisabled,
    };
    // Keep every Netflix order in the stable control list, including an
    // account-less order that staff still need to switch to manual delivery or
    // whose registered buyer needs self-service restored.
    orderControls.set(order.orderId, control);
    if (!account) continue;
    const hash = netflixAccountHash(account);
    if (!accountByHash.has(hash)) accountByHash.set(hash, account);
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(control);
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
      || controls.some((control) => control.orderId.toLowerCase().includes(query)
        || control.deliveryEmail.includes(query)
        || control.ownerEmail.includes(query))
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

  const [accessRows, storedEventRows] = await Promise.all([
    query && (scope === "access" || scope === "mail") ? listAllNetflixCodeAccess() : listNetflixCodeAccess({ limit: 200 }),
    query && scope === "mail" ? listAllNetflixMailEvents() : listNetflixMailEvents({ limit: 100 }),
  ]);
  const access = filterNetflixAccessRecords(accessRows.map((entry) => ({
    id: entry.id,
    orderId: entry.orderId,
    userEmail: entry.userEmail || "",
    accountEmail: entry.accountEmail || entry.accountHint || "",
    outcome: entry.outcome,
    eventId: entry.eventId,
    createdAtBeijing: entry.createdAtBeijing,
  })), scope === "access" ? query : "").slice(0, 200);
  const accessedOrdersByEvent = new Map();
  for (const entry of accessRows) {
    if (!entry.eventId || !entry.orderId) continue;
    if (!accessedOrdersByEvent.has(entry.eventId)) accessedOrdersByEvent.set(entry.eventId, new Set());
    accessedOrdersByEvent.get(entry.eventId).add(entry.orderId);
  }
  const eventRows = storedEventRows.map((event) => {
    const matchedAccountHashes = Array.from(event.accountHashes || [])
      .filter((hash) => byHash.has(hash))
      .sort();
    const fullAccountEmails = operationalAccountHints([
      ...revealNetflixMailAccountEmails(event),
      ...matchedAccountHashes.map((hash) => accountByHash.get(hash)),
    ]);
    const accountEmails = fullAccountEmails.length
      ? fullAccountEmails
      : operationalAccountHints(event.accountHints);
    const matchedOrders = Array.from(new Set((event.accountHashes || [])
      .flatMap((hash) => byHash.get(hash) || [])
      .map((order) => order.orderId)))
      .map((orderId) => orderControls.get(orderId))
      .filter(Boolean);
    const accessedOrderIds = accessedOrdersByEvent.get(event.eventId) || new Set();
    const exactOrders = Array.from(accessedOrderIds)
      .map((orderId) => orderControls.get(orderId))
      .filter(Boolean);
    const searchOrders = [...exactOrders, ...matchedOrders].map((order) => ({
      ...order,
      accountEmail: accountByOrderId.get(order.orderId),
    }));
    return {
      eventId: event.eventId,
      accepted: event.accepted,
      kind: event.kind,
      result: revealNetflixMailResult(event),
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
      accountEmails,
      accountHints: operationalAccountHints(event.accountHints),
      searchHashes: Array.from(event.accountHashes || []),
      // Direct access history remains authoritative even after staff replace
      // the Netflix account on an order. Include both that historical link and
      // current account-hash matches so an old order stays searchable.
      searchValues: netflixMailSearchValues(searchOrders).concat(fullAccountEmails),
      matchedOrderCount: matchedOrders.length,
      orders: exactOrders.length ? exactOrders : matchedOrders.length === 1 ? matchedOrders : [],
    };
  });
  const normalizedEvents = compactNetflixMailEvents(eventRows);
  const recentAcceptedCount = normalizedEvents.filter((event) => event.accepted).length;
  const events = filterNetflixMailEvents(normalizedEvents, scope === "mail" ? query : "", queryHash)
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
    const expectedRevision = Number(entry.order.revision ?? 0);
    entry.order.netflixSelfServiceEnabled = body.enabled !== false;
    if (!await setOrderAt(entry.index, entry.order, { expectedRevision })) {
      return Response.json({ ok: false, error: "stale_revision" }, { status: 409 });
    }
    await pushAdminActionLog({ action: "netflix_code_order_toggle", actor, target: `order:${orderId}`, detail: { enabled: entry.order.netflixSelfServiceEnabled } });
    return Response.json({ ok: true, enabled: entry.order.netflixSelfServiceEnabled });
  }

  if (action === "toggle_user") {
    const { ownerEmail } = netflixOrderIdentity(entry.order);
    if (!ownerEmail) return Response.json({ ok: false, error: "user_not_found" }, { status: 404 });
    const state = await readUserAuthState(ownerEmail);
    if (!state.ok) {
      return Response.json({ ok: false, error: state.error || "user_not_found" }, {
        status: state.status === 401 ? 404 : 503,
      });
    }
    const user = state.user;
    user.netflixSelfServiceDisabled = body.enabled === false;
    const saved = await setUser(ownerEmail, user, {
      expectedAuthVersion: state.authVersion,
      expectedAccountLifecycleId: state.accountLifecycleId,
      updateOnly: true,
      returnResult: true,
    });
    if (!saved?.ok) {
      const conflict = saved?.error === "session_state_changed" || saved?.error === "account_lifecycle_changed";
      return Response.json({ ok: false, error: saved?.error || "save_failed" }, { status: conflict ? 409 : 500 });
    }
    await pushAdminActionLog({ action: "netflix_code_user_toggle", actor, target: `user:${ownerEmail}`, detail: { enabled: !user.netflixSelfServiceDisabled } });
    return Response.json({ ok: true, enabled: !user.netflixSelfServiceDisabled, ownerEmail });
  }

  if (action === "clear_lock") {
    await clearNetflixCodeLock(orderId);
    await pushAdminActionLog({ action: "netflix_code_lock_clear", actor, target: `order:${orderId}`, detail: {} });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false, error: "invalid_action" }, { status: 400 });
}
