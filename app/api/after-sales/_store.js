import { clean, formatBeijingTime, redisCmd, redisPipeline, redisConfig } from "../_utils.js";
import { randomBytes } from "node:crypto";

const TICKET_PREFIX = "liumeiti:after-sales:record:";
const ACTIVE_ORDER_PREFIX = "liumeiti:after-sales:active:";
const ALL_INDEX = "liumeiti:after-sales:index";
const PENDING_INDEX = "liumeiti:after-sales:status:pending";
const COMPLETED_INDEX = "liumeiti:after-sales:status:completed";
const COMPLETE_LOCK_PREFIX = "liumeiti:after-sales:complete-lock:";

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

export async function createAfterSalesTicket(ticket) {
  if (!redisConfig() || !ticket?.ticketId || !ticket?.orderId) {
    return { ok: false, error: "storage_unavailable" };
  }
  const ticketId = normalizeId(ticket.ticketId);
  const orderId = normalizeId(ticket.orderId, 80);
  const activeKey = activeOrderKey(orderId);

  const existingId = normalizeId(await redisCmd(["GET", activeKey]));
  if (existingId) {
    const existing = await getAfterSalesTicket(existingId);
    if (!existing || existing.status === "pending") {
      return {
        ok: false,
        error: "pending_ticket_exists",
        ticket: existing || { ticketId: existingId, orderId, status: "pending", storagePending: true },
      };
    }
    await compareDelete(activeKey, existingId);
  }

  // 临时锁覆盖「已抢锁、记录尚未落盘」窗口；保存成功后会改为不失效的待处理锁。
  const acquired = await redisCmd(["SET", activeKey, ticketId, "NX", "EX", "300"]);
  if (acquired !== "OK") {
    const current = await getActiveAfterSalesTicket(orderId);
    return { ok: false, error: "pending_ticket_exists", ticket: current };
  }

  const score = createdScore(ticket);
  const commands = [
    ["SET", ticketKey(ticketId), JSON.stringify({ ...ticket, ticketId, orderId })],
    ["ZADD", ALL_INDEX, String(score), ticketId],
    ["ZADD", PENDING_INDEX, String(score), ticketId],
    ["ZREM", COMPLETED_INDEX, ticketId],
    ["SET", activeKey, ticketId],
  ];
  const saved = writeSucceeded(await redisPipeline(commands), commands.length);
  if (!saved) {
    await compareDelete(activeKey, ticketId);
    await redisPipeline([
      ["DEL", ticketKey(ticketId)],
      ["ZREM", ALL_INDEX, ticketId],
      ["ZREM", PENDING_INDEX, ticketId],
      ["ZREM", COMPLETED_INDEX, ticketId],
    ]);
    return { ok: false, error: "storage_failed" };
  }
  return { ok: true, ticket: { ...ticket, ticketId, orderId } };
}

export async function completeAfterSalesTicket(ticketId, staffNote, actor) {
  const id = normalizeId(ticketId);
  const lockKey = COMPLETE_LOCK_PREFIX + id;
  const lockToken = randomBytes(12).toString("hex");
  const locked = await redisCmd(["SET", lockKey, lockToken, "NX", "EX", "30"]);
  if (locked !== "OK") return { ok: false, error: "ticket_busy" };
  try {
    const ticket = await getAfterSalesTicket(id);
    if (!ticket) return { ok: false, error: "ticket_not_found" };
    if (ticket.status === "completed") return { ok: true, ticket, changed: false };
    if (ticket.status !== "pending") return { ok: false, error: "invalid_ticket_status" };

    const now = new Date();
    const completed = {
      ...ticket,
      status: "completed",
      staffNote: clean(staffNote, 2000),
      completedAt: now.toISOString(),
      completedAtBeijing: formatBeijingTime(now),
      completedBy: {
        staffId: Number(actor?.staffId || 1),
        staffUsername: clean(actor?.staffUsername || "admin", 60),
      },
      updatedAt: now.toISOString(),
    };
    const score = createdScore(completed);
    const commands = [
      ["SET", ticketKey(completed.ticketId), JSON.stringify(completed)],
      ["ZREM", PENDING_INDEX, completed.ticketId],
      ["ZADD", COMPLETED_INDEX, String(score), completed.ticketId],
    ];
    const saved = writeSucceeded(await redisPipeline(commands), commands.length);
    if (!saved) return { ok: false, error: "storage_failed" };
    await compareDelete(activeOrderKey(completed.orderId), completed.ticketId);
    return { ok: true, ticket: completed, changed: true };
  } finally {
    await compareDelete(lockKey, lockToken);
  }
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
  const matched = records.filter((ticket) => [
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
