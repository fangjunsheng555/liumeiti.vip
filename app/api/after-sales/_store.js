import {
  clean,
  formatBeijingTime,
  getOrderById,
  getOrderEntryById,
  getOrdersByInternalReference,
  redisCmd,
  redisPipeline,
  redisConfig,
  setOrderAt,
} from "../_utils.js";
import { randomBytes } from "node:crypto";

const TICKET_PREFIX = "liumeiti:after-sales:record:";
const ACTIVE_ORDER_PREFIX = "liumeiti:after-sales:active:";
const ALL_INDEX = "liumeiti:after-sales:index";
const PENDING_INDEX = "liumeiti:after-sales:status:pending";
const COMPLETED_INDEX = "liumeiti:after-sales:status:completed";
const COMPLETION_OUTBOX_INDEX = "liumeiti:after-sales:completion-outbox";
const COMPLETE_LOCK_PREFIX = "liumeiti:after-sales:complete-lock:";
const CREDENTIAL_SERVICES = new Set(["spotify", "ai", "netflix", "disney", "max"]);

const CREATE_TICKET_SCRIPT = `
local activeId=redis.call('GET',KEYS[2])
if activeId then
  local activeRaw=redis.call('GET',ARGV[5]..activeId)
  if not activeRaw then
    return cjson.encode({ok=false,error='pending_ticket_exists',ticketId=activeId,storagePending=true})
  end
  local parsed,active=pcall(cjson.decode,activeRaw)
  if not parsed or type(active)~='table' or tostring(active.status or '')=='pending' then
    return cjson.encode({ok=false,error='pending_ticket_exists',ticketId=activeId})
  end
  redis.call('DEL',KEYS[2])
end
if redis.call('EXISTS',KEYS[1])==1 then
  return cjson.encode({ok=false,error='ticket_id_conflict'})
end
redis.call('SET',KEYS[1],ARGV[1])
redis.call('ZADD',KEYS[3],ARGV[2],ARGV[3])
redis.call('ZADD',KEYS[4],ARGV[2],ARGV[3])
redis.call('ZREM',KEYS[5],ARGV[3])
redis.call('SET',KEYS[2],ARGV[3])
return cjson.encode({ok=true})`;

const COMPLETE_TICKET_SCRIPT = `
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[2])
redis.call('ZREM',KEYS[2],ARGV[3])
redis.call('ZADD',KEYS[3],ARGV[4],ARGV[3])
if ARGV[5]~='' then redis.call('ZADD',KEYS[4],ARGV[6],ARGV[3]) end
if redis.call('GET',KEYS[5])==ARGV[3] then redis.call('DEL',KEYS[5]) end
return 1`;

const COMPLETE_EFFECTS_SCRIPT = `
local raw=redis.call('GET',KEYS[1])
if not raw then return 0 end
local ok,ticket=pcall(cjson.decode,raw)
if not ok or type(ticket)~='table' or tostring(ticket.completionOperationId or '')~=ARGV[1] then return 0 end
ticket.completionEffectsPending=false
ticket.completionEffectsCompletedAt=ARGV[2]
redis.call('SET',KEYS[1],cjson.encode(ticket))
redis.call('ZREM',KEYS[2],ARGV[3])
return 1`;

const CREATE_EFFECTS_SCRIPT = `
local raw=redis.call('GET',KEYS[1])
if not raw then return 0 end
local ok,ticket=pcall(cjson.decode,raw)
if not ok or type(ticket)~='table' or tostring(ticket.ticketId or '')~=ARGV[1] then return 0 end
ticket.creationEffectsPending=false
ticket.creationEffectsCompletedAt=ARGV[2]
redis.call('SET',KEYS[1],cjson.encode(ticket))
return 1`;

const REPAIR_COMPLETED_TICKET_SCRIPT = `
redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2])
redis.call('ZREM',KEYS[2],ARGV[2])
redis.call('ZADD',KEYS[3],ARGV[1],ARGV[2])
if ARGV[3]=='1' then redis.call('ZADD',KEYS[4],ARGV[4],ARGV[2]) else redis.call('ZREM',KEYS[4],ARGV[2]) end
if redis.call('GET',KEYS[5])==ARGV[2] then redis.call('DEL',KEYS[5]) end
return 1`;

function normalizeId(value, limit = 100) {
  return clean(value, limit).replace(/\s+/g, "").toUpperCase();
}

function ticketKey(ticketId) {
  const id = normalizeId(ticketId);
  return id ? TICKET_PREFIX + id : "";
}

function activeOrderKey(orderId) {
  const id = normalizeId(orderId, 80);
  return id ? ACTIVE_ORDER_PREFIX + id : "";
}

function parseRecord(value) {
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
  if (entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "result")) {
    return entry.result;
  }
  return entry;
}

async function getTicketsByIds(ids) {
  const cleanIds = (Array.isArray(ids) ? ids : []).map((id) => normalizeId(id)).filter(Boolean);
  if (!cleanIds.length) return [];
  const response = await redisPipeline(cleanIds.map((id) => ["GET", ticketKey(id)]));
  const rows = pipelineRows(response);
  return rows.map((entry) => parseRecord(pipelineValue(entry))).filter(Boolean);
}

async function compareDelete(key, expected) {
  if (!key || !expected) return false;
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  return Number(await redisCmd(["EVAL", script, "1", key, expected])) > 0;
}

function indexForStatus(status) {
  if (status === "pending") return PENDING_INDEX;
  if (status === "completed") return COMPLETED_INDEX;
  return ALL_INDEX;
}

function createdScore(ticket) {
  const score = new Date(ticket?.createdAt || 0).getTime();
  return Number.isFinite(score) && score > 0 ? score : Date.now();
}

function writeSucceeded(result, expectedCount) {
  const rows = pipelineRows(result);
  return rows.length === expectedCount && rows.every((entry) => !entry?.error);
}

export async function getAfterSalesTicket(ticketId) {
  const key = ticketKey(ticketId);
  if (!key) return null;
  return parseRecord(await redisCmd(["GET", key]));
}

export async function getActiveAfterSalesTicket(orderId) {
  const key = activeOrderKey(orderId);
  if (!key) return null;
  const ticketId = normalizeId(await redisCmd(["GET", key]));
  if (!ticketId) return null;
  const ticket = await getAfterSalesTicket(ticketId);
  if (ticket?.status === "pending") return ticket;
  if (!ticket) return { ticketId, orderId: normalizeId(orderId, 80), status: "pending", storagePending: true };
  await compareDelete(key, ticketId);
  return null;
}

export async function getActiveAfterSalesTickets(orderIds) {
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).map((id) => normalizeId(id, 80)).filter(Boolean))];
  if (!ids.length || !redisConfig()) return {};
  const activeRows = pipelineRows(await redisPipeline(ids.map((orderId) => ["GET", activeOrderKey(orderId)])));
  const activeIds = activeRows.map((entry) => normalizeId(pipelineValue(entry))).filter(Boolean);
  const records = await getTicketsByIds([...new Set(activeIds)]);
  const byTicketId = new Map(records.map((ticket) => [normalizeId(ticket.ticketId), ticket]));
  const result = {};
  for (let index = 0; index < ids.length; index += 1) {
    const orderId = ids[index];
    const ticketId = normalizeId(pipelineValue(activeRows[index]));
    if (!ticketId) continue;
    const ticket = byTicketId.get(ticketId);
    if (ticket?.status === "pending") result[orderId] = ticket;
    else if (!ticket) result[orderId] = { ticketId, orderId, status: "pending", storagePending: true };
    else await compareDelete(activeOrderKey(orderId), ticketId);
  }
  return result;
}

function isCredentialService(service) {
  return CREDENTIAL_SERVICES.has(clean(service, 40).toLowerCase());
}

export async function hydrateAfterSalesTicketCredentials(ticket) {
  if (!ticket) return null;
  const order = await getOrderById(ticket.orderId);
  const orderItems = Array.isArray(order?.items) && order.items.length
    ? order.items
    : order
      ? [{
          service: order.service || "",
          account: order.staffAccount || order.account || "",
          password: order.staffPassword || order.password || "",
        }]
      : [];
  return {
    ...ticket,
    items: (Array.isArray(ticket.items) ? ticket.items : []).map((item, arrayIndex) => {
      const index = Number.isFinite(Number(item?.index)) ? Number(item.index) : arrayIndex;
      const source = orderItems[index] || {};
      const credentialManaged = Boolean(item.credentialManaged || isCredentialService(item.service || source.service));
      if (!credentialManaged) return { ...item, index };
      return {
        ...item,
        index,
        credentialManaged: true,
        account: clean(item.account || source.staffAccount || source.account, 80),
        password: clean(item.password || source.staffPassword || source.password, 120),
      };
    }),
  };
}

export async function createAfterSalesTicket(ticket) {
  if (!redisConfig() || !ticket?.ticketId || !ticket?.orderId) {
    return { ok: false, error: "storage_unavailable" };
  }
  const ticketId = normalizeId(ticket.ticketId);
  const orderId = normalizeId(ticket.orderId, 80);
  const activeKey = activeOrderKey(orderId);
  const score = createdScore(ticket);
  const normalized = { ...ticket, ticketId, orderId, creationEffectsPending: true };
  const raw = await redisCmd([
    "EVAL", CREATE_TICKET_SCRIPT, "5",
    ticketKey(ticketId), activeKey, ALL_INDEX, PENDING_INDEX, COMPLETED_INDEX,
    JSON.stringify(normalized), String(score), ticketId, orderId, TICKET_PREFIX,
  ]);
  let result = null;
  try { result = typeof raw === "string" ? JSON.parse(raw) : raw; } catch {}
  if (!result?.ok) {
    const existingId = normalizeId(result?.ticketId);
    const existing = existingId ? await getAfterSalesTicket(existingId) : null;
    return {
      ok: false,
      error: result?.error || "storage_failed",
      ticket: existing || (existingId ? { ticketId: existingId, orderId, status: "pending", storagePending: Boolean(result?.storagePending) } : null),
    };
  }
  return { ok: true, ticket: normalized };
}

function mergeCompletionItems(ticket, updates) {
  const submitted = new Map((Array.isArray(updates) ? updates : []).map((item) => [Number(item?.index), item]));
  const items = (Array.isArray(ticket?.items) ? ticket.items : []).map((item, arrayIndex) => {
    const index = Number.isFinite(Number(item?.index)) ? Number(item.index) : arrayIndex;
    const hasCredentials = Boolean(item?.credentialManaged || isCredentialService(item?.service) || item?.account || item?.password);
    if (!hasCredentials) return { ...item, index };
    const update = submitted.get(index) || {};
    return {
      ...item,
      index,
      credentialManaged: true,
      account: clean(update.account ?? item.account, 80),
      password: clean(update.password ?? item.password, 120),
    };
  });
  if (items.some((item) => (item.account || item.password) && (!item.account || !item.password))) {
    return { ok: false, error: "missing_credentials" };
  }
  return { ok: true, items };
}

async function syncOrderCredentials(ticket, items, actor, operationId = "", requestHash = "") {
  const credentialItems = items.filter((item) => item.credentialManaged && item.account && item.password);
  if (!credentialItems.length) return { ok: true };

  const orderEntry = await getOrderEntryById(ticket.orderId);
  const order = orderEntry?.order;
  if (!order) return { ok: false, error: "order_not_found" };
  const stableOperation = clean(operationId, 100);
  const stableRequestHash = clean(requestHash, 80);
  const syncRecords = Array.isArray(order.afterSalesCredentialSyncs) ? order.afterSalesCredentialSyncs : [];
  const priorTicketSync = syncRecords.find((entry) => normalizeId(entry?.ticketId) === normalizeId(ticket.ticketId));
  if (priorTicketSync) {
    if (stableRequestHash && priorTicketSync.requestHash !== stableRequestHash) {
      return { ok: false, error: "idempotency_conflict" };
    }
    return { ok: true, idempotent: true };
  }
  const processedSyncs = Array.isArray(order.afterSalesCredentialSyncOperations)
    ? order.afterSalesCredentialSyncOperations.map((value) => clean(value, 100)).filter(Boolean)
    : [];
  // The marker and credentials are part of the same order CAS write. A crash
  // after that write therefore resumes without a second revision/audit entry.
  if (stableOperation && processedSyncs.includes(stableOperation)) return { ok: true, idempotent: true };
  const expectedRevision = Number(order.revision ?? 0);
  if (!Array.isArray(order.items) || !order.items.length) {
    const source = credentialItems[0] || items[0] || {};
    order.items = [{
      service: order.service || source.service || "",
      label: order.serviceLabel || source.label || "",
      cycle: order.cycle || "",
      amount: Number(order.finalAmount || 0),
      plan: order.plan || order.rocketPlan || source.plan || "",
      account: order.account || source.account || "",
      password: order.password || source.password || "",
    }];
  }

  for (const item of credentialItems) {
    const index = Number(item.index);
    const target = Number.isFinite(index) ? order.items[index] : null;
    if (!target) return { ok: false, error: "order_item_not_found" };
    const service = clean(item.service || target.service, 40).toLowerCase();
    if (service === "spotify") {
      // Spotify credentials are buyer-provided and edited through account/password
      // throughout the order UI. Remove stale staff overrides so the latest values
      // are also returned by the customer-facing order views.
      target.account = item.account;
      target.password = item.password;
      target.staffAccount = "";
      target.staffPassword = "";
    } else {
      target.staffAccount = item.account;
      target.staffPassword = item.password;
    }
  }

  if (order.items.length === 1 && credentialItems.length === 1) {
    const item = credentialItems[0];
    const service = clean(item.service || order.items[0]?.service || order.service, 40).toLowerCase();
    if (service === "spotify") {
      order.account = item.account;
      order.password = item.password;
      order.staffAccount = "";
      order.staffPassword = "";
    } else {
      order.staffAccount = item.account;
      order.staffPassword = item.password;
    }
  }
  const now = new Date();
  order.staffAudit = Array.isArray(order.staffAudit) ? order.staffAudit : [];
  order.staffAudit.unshift({
    id: stableOperation ? `OA${stableOperation.slice(0, 22).toUpperCase()}` : "OA" + Date.now().toString(36).toUpperCase(),
    operationId: stableOperation,
    staffId: Number(actor?.staffId || 1),
    staffUsername: clean(actor?.staffUsername || "admin", 60),
    label: clean(actor?.staffUsername || "admin", 60),
    action: "after_sales_credentials_sync",
    status: order.status || "completed",
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
  });
  order.staffAudit = order.staffAudit.slice(0, 30);
  if (stableOperation) {
    order.afterSalesCredentialSyncOperations = [stableOperation, ...processedSyncs.filter((value) => value !== stableOperation)].slice(0, 100);
    order.afterSalesCredentialSyncs = [{
      ticketId: normalizeId(ticket.ticketId),
      requestHash: stableRequestHash,
      operationId: stableOperation,
    }, ...syncRecords.filter((entry) => normalizeId(entry?.ticketId) !== normalizeId(ticket.ticketId))].slice(0, 100);
  }
  const saved = await setOrderAt(
    orderEntry.index,
    order,
    { expectedRevision },
  );
  if (!saved) return { ok: false, error: "order_sync_failed" };

  const persisted = await getOrderById(order.orderId);
  const persistedItems = Array.isArray(persisted?.items) ? persisted.items : [];
  const credentialsMatch = credentialItems.every((item) => {
    const target = persistedItems[Number(item.index)];
    if (!target) return false;
    const service = clean(item.service || target.service, 40).toLowerCase();
    return service === "spotify"
      ? target.account === item.account
        && target.password === item.password
        && !target.staffAccount
        && !target.staffPassword
      : target.staffAccount === item.account && target.staffPassword === item.password;
  });
  return credentialsMatch ? { ok: true } : { ok: false, error: "order_sync_failed" };
}

export async function completeAfterSalesTicket(ticketId, completion, actor) {
  const id = normalizeId(ticketId);
  const lockKey = COMPLETE_LOCK_PREFIX + id;
  const lockToken = randomBytes(12).toString("hex");
  const locked = await redisCmd(["SET", lockKey, lockToken, "NX", "EX", "30"]);
  if (locked !== "OK") return { ok: false, error: "ticket_busy" };
  try {
    const storedRaw = await redisCmd(["GET", ticketKey(id)]);
    const storedTicket = parseRecord(storedRaw);
    if (!storedTicket) return { ok: false, error: "ticket_not_found" };
    const ticket = await hydrateAfterSalesTicketCredentials(storedTicket);
    const payload = completion && typeof completion === "object" ? completion : { staffNote: completion };
    const completionOperationId = clean(payload.operationId, 100);
    const completionRequestHash = clean(payload.requestHash, 80);
    if (ticket.status === "completed") {
      const owned = Boolean(completionOperationId && ticket.completionOperationId === completionOperationId);
      if (owned && ticket.completionRequestHash && ticket.completionRequestHash !== completionRequestHash) {
        return { ok: false, error: "idempotency_conflict" };
      }
      if (owned) {
        await redisCmd([
          "EVAL", REPAIR_COMPLETED_TICKET_SCRIPT, "5",
          ALL_INDEX, PENDING_INDEX, COMPLETED_INDEX, COMPLETION_OUTBOX_INDEX, activeOrderKey(ticket.orderId),
          String(createdScore(ticket)), ticket.ticketId, ticket.completionEffectsPending ? "1" : "0", String(Date.now()),
        ]);
      }
      return { ok: true, ticket, changed: false, owned };
    }
    if (ticket.status !== "pending") return { ok: false, error: "invalid_ticket_status" };

    const merged = mergeCompletionItems(ticket, payload.items);
    if (!merged.ok) return merged;
    const synced = await syncOrderCredentials(ticket, merged.items, actor, completionOperationId, completionRequestHash);
    if (!synced.ok) return synced;

    const now = new Date();
    const completed = {
      ...ticket,
      status: "completed",
      items: merged.items,
      staffNote: clean(payload.staffNote, 2000),
      completedAt: now.toISOString(),
      completedAtBeijing: formatBeijingTime(now),
      completedBy: {
        staffId: Number(actor?.staffId || 1),
        staffUsername: clean(actor?.staffUsername || "admin", 60),
      },
      ...(completionOperationId ? {
        completionOperationId,
        completionRequestHash,
        completionEffectsPending: true,
      } : {}),
      updatedAt: now.toISOString(),
    };
    const score = createdScore(completed);
    const saved = Number(await redisCmd([
      "EVAL", COMPLETE_TICKET_SCRIPT, "5",
      ticketKey(completed.ticketId), PENDING_INDEX, COMPLETED_INDEX, COMPLETION_OUTBOX_INDEX, activeOrderKey(completed.orderId),
      String(storedRaw), JSON.stringify(completed), completed.ticketId, String(score), completionOperationId, String(Date.now()),
    ])) === 1;
    if (!saved) return { ok: false, error: "storage_failed" };
    return { ok: true, ticket: completed, changed: true, owned: Boolean(completionOperationId) };
  } finally {
    await compareDelete(lockKey, lockToken);
  }
}

export async function getAfterSalesCompletionOutbox(limit = 30) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 30)));
  const ids = await redisCmd(["ZRANGE", COMPLETION_OUTBOX_INDEX, "0", String(safeLimit - 1)]);
  return getTicketsByIds(ids);
}

export async function getAfterSalesCreationOutbox(limit = 30) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 30)));
  const ids = await redisCmd(["ZREVRANGE", PENDING_INDEX, "0", String(safeLimit - 1)]);
  return (await getTicketsByIds(ids)).filter((ticket) => ticket.creationEffectsPending !== false);
}

export async function markAfterSalesCreationEffectsDone(ticketId) {
  const id = normalizeId(ticketId);
  if (!id) return false;
  return Number(await redisCmd([
    "EVAL", CREATE_EFFECTS_SCRIPT, "1", ticketKey(id), id, new Date().toISOString(),
  ])) === 1;
}

export async function markAfterSalesCompletionEffectsDone(ticketId, operationId) {
  const id = normalizeId(ticketId);
  const stableOperation = clean(operationId, 100);
  if (!id || !stableOperation) return false;
  return Number(await redisCmd([
    "EVAL", COMPLETE_EFFECTS_SCRIPT, "2",
    ticketKey(id), COMPLETION_OUTBOX_INDEX,
    stableOperation, new Date().toISOString(), id,
  ])) === 1;
}

export async function getAfterSalesCounts() {
  if (!redisConfig()) return { all: 0, pending: 0, completed: 0 };
  const rows = pipelineRows(await redisPipeline([
    ["ZCARD", ALL_INDEX],
    ["ZCARD", PENDING_INDEX],
    ["ZCARD", COMPLETED_INDEX],
  ]));
  return {
    all: Number(pipelineValue(rows[0]) ?? 0),
    pending: Number(pipelineValue(rows[1]) ?? 0),
    completed: Number(pipelineValue(rows[2]) ?? 0),
  };
}

export async function listAfterSalesTickets({ status = "all", query = "", offset = 0, limit = 60 } = {}) {
  if (!redisConfig()) return { tickets: [], total: 0, hasMore: false, counts: await getAfterSalesCounts() };
  const safeStatus = ["pending", "completed"].includes(status) ? status : "all";
  const safeOffset = Math.max(0, Number(offset || 0));
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 60)));
  const q = clean(query, 200).toLowerCase();
  const key = indexForStatus(safeStatus);
  const counts = await getAfterSalesCounts();

  if (!q) {
    const total = Number(await redisCmd(["ZCARD", key]) || 0);
    const ids = await redisCmd(["ZREVRANGE", key, String(safeOffset), String(safeOffset + safeLimit - 1)]);
    const tickets = (await getTicketsByIds(ids)).map(adminAfterSalesSummary);
    return { tickets, total, hasMore: safeOffset + tickets.length < total, counts };
  }

  // 搜索属于后台主动操作；只在搜索时读取记录，常规列表始终按索引分页。
  const ids = await redisCmd(["ZREVRANGE", key, "0", "4999"]);
  const records = [];
  for (let start = 0; start < (Array.isArray(ids) ? ids.length : 0); start += 100) {
    records.push(...await getTicketsByIds(ids.slice(start, start + 100)));
  }
  const referenceOrders = q.length <= 32 && /^[a-z0-9_-]+$/i.test(q)
    ? await getOrdersByInternalReference(q, 500)
    : [];
  const referenceOrderIds = new Set(referenceOrders.map((order) => normalizeId(order.orderId, 80)));
  const matched = records.filter((ticket) => referenceOrderIds.has(normalizeId(ticket.orderId, 80)) || [
    ticket.ticketId, ticket.orderId, ticket.email, ticket.contact, ticket.serviceLabel, ticket.issue,
  ].join(" ").toLowerCase().includes(q));
  return {
    tickets: matched.slice(safeOffset, safeOffset + safeLimit).map(adminAfterSalesSummary),
    total: matched.length,
    hasMore: safeOffset + safeLimit < matched.length,
    counts,
  };
}

export function publicAfterSalesSummary(ticket) {
  if (!ticket) return null;
  return {
    ticketId: ticket.ticketId || "",
    orderId: ticket.orderId || "",
    status: ticket.status || "pending",
    createdAtBeijing: ticket.createdAtBeijing || "",
    completedAtBeijing: ticket.completedAtBeijing || "",
  };
}

function adminAfterSalesSummary(ticket) {
  return {
    ticketId: ticket.ticketId || "",
    orderId: ticket.orderId || "",
    status: ticket.status || "pending",
    email: ticket.email || "",
    serviceLabel: ticket.serviceLabel || "",
    issue: ticket.issue || "",
    createdAtBeijing: ticket.createdAtBeijing || "",
    completedAtBeijing: ticket.completedAtBeijing || "",
  };
}
