import {
  clean,
  formatBeijingTime,
  getOrderById,
  getOrderEntryById,
  getOrdersByInternalReference,
  redisCmd,
  redisPipeline,
  redisConfig,
  replaceTopLevelJsonFields,
  setOrderAt,
  validEmail,
} from "../_utils.js";
import { createHash, randomBytes } from "node:crypto";

const TICKET_PREFIX = "liumeiti:after-sales:record:";
const ACTIVE_ORDER_PREFIX = "liumeiti:after-sales:active:";
const ALL_INDEX = "liumeiti:after-sales:index";
const PENDING_INDEX = "liumeiti:after-sales:status:pending";
const COMPLETED_INDEX = "liumeiti:after-sales:status:completed";
const CREATION_OUTBOX_INDEX = "liumeiti:after-sales:creation-outbox";
const COMPLETION_OUTBOX_INDEX = "liumeiti:after-sales:completion-outbox";
const CREATION_OUTBOX_BACKFILL_CURSOR = "liumeiti:after-sales:creation-outbox:backfill:v1";
const CREATION_OUTBOX_BACKFILL_LOCK = "liumeiti:after-sales:creation-outbox:backfill-lock:v1";
const COMPLETE_LOCK_PREFIX = "liumeiti:after-sales:complete-lock:";
const CREDENTIAL_SERVICES = new Set(["spotify", "ai", "netflix", "disney", "max"]);

const CREATE_TICKET_SCRIPT = `
local function validtype(key,expected)
  local value=redis.call('TYPE',key)
  local actual=type(value)=='table' and value.ok or value
  return actual=='none' or actual==expected
end
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string')
  or not validtype(KEYS[3],'zset') or not validtype(KEYS[4],'zset')
  or not validtype(KEYS[5],'zset') or not validtype(KEYS[6],'zset') then
  return redis.error_reply('after_sales_storage_type_error')
end
local score=tonumber(ARGV[2])
if not score or score~=score or score<-9007199254740991 or score>9007199254740991 then
  return redis.error_reply('after_sales_score_error')
end
local nextOk,nextTicket=pcall(cjson.decode,ARGV[1])
if not nextOk or type(nextTicket)~='table' or tostring(nextTicket.ticketId or '')~=ARGV[3]
  or tostring(nextTicket.orderId or '')~=ARGV[4] or tostring(nextTicket.status or '')~='pending' then
  return redis.error_reply('after_sales_ticket_invalid')
end
local activeId=redis.call('GET',KEYS[2])
if activeId then
  local activeRaw=redis.call('GET',ARGV[5]..activeId)
  if not activeRaw then
    local responseOk,response=pcall(cjson.encode,{ok=false,error='pending_ticket_exists',ticketId=activeId,storagePending=true})
    if not responseOk then return redis.error_reply('after_sales_response_encode_failed') end
    return response
  end
  local parsed,active=pcall(cjson.decode,activeRaw)
  if not parsed or type(active)~='table' or tostring(active.ticketId or '')~=activeId
    or tostring(active.orderId or '')~=ARGV[4] or tostring(active.status or '')=='pending' then
    local responseOk,response=pcall(cjson.encode,{ok=false,error='pending_ticket_exists',ticketId=activeId})
    if not responseOk then return redis.error_reply('after_sales_response_encode_failed') end
    return response
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
redis.call('ZADD',KEYS[6],ARGV[2],ARGV[3])
redis.call('SET',KEYS[2],ARGV[3])
return cjson.encode({ok=true})`;

const COMPLETE_TICKET_SCRIPT = `
local function validtype(key,expected)
  local value=redis.call('TYPE',key)
  local actual=type(value)=='table' and value.ok or value
  return actual=='none' or actual==expected
end
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'zset')
  or not validtype(KEYS[3],'zset') or not validtype(KEYS[4],'zset')
  or not validtype(KEYS[5],'string') then return redis.error_reply('after_sales_storage_type_error') end
local hasCompletionOperation=ARGV[7]=='1'
local completedScore=tonumber(ARGV[4]); local outboxScore=hasCompletionOperation and tonumber(ARGV[6]) or 0
if not completedScore or completedScore~=completedScore or completedScore<-9007199254740991 or completedScore>9007199254740991
  or not outboxScore or outboxScore~=outboxScore or outboxScore<-9007199254740991 or outboxScore>9007199254740991 then
  return redis.error_reply('after_sales_score_error')
end
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
local oldOk,oldTicket=pcall(cjson.decode,ARGV[1]); local nextOk,nextTicket=pcall(cjson.decode,ARGV[2])
if not oldOk or type(oldTicket)~='table' or not nextOk or type(nextTicket)~='table'
  or tostring(oldTicket.ticketId or '')~=ARGV[3] or tostring(nextTicket.ticketId or '')~=ARGV[3]
  or tostring(oldTicket.orderId or '')~=tostring(nextTicket.orderId or '')
  or tostring(oldTicket.status or '')~='pending' or tostring(nextTicket.status or '')~='completed' then return 0 end
redis.call('SET',KEYS[1],ARGV[2])
redis.call('ZREM',KEYS[2],ARGV[3])
redis.call('ZADD',KEYS[3],ARGV[4],ARGV[3])
if hasCompletionOperation then redis.call('ZADD',KEYS[4],ARGV[6],ARGV[3]) end
if redis.call('GET',KEYS[5])==ARGV[3] then redis.call('DEL',KEYS[5]) end
return 1`;

const MARK_EFFECTS_SCRIPT = `
local function validtype(key,expected)
  local value=redis.call('TYPE',key)
  local actual=type(value)=='table' and value.ok or value
  return actual=='none' or actual==expected
end
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'zset') then
  return redis.error_reply('after_sales_storage_type_error')
end
local raw=redis.call('GET',KEYS[1])
if not raw then return 0 end
if raw~=ARGV[1] then return -1 end
local ok,ticket=pcall(cjson.decode,raw)
if not ok or type(ticket)~='table' then return 0 end
if tostring(ticket.ticketId or '')~=ARGV[5] then return 0 end
if ARGV[3]=='completion' then
  if tostring(ticket.completionOperationId or '')~=ARGV[4] then return 0 end
elseif ARGV[3]=='creation' then
  if tostring(ticket.ticketId or '')~=ARGV[5] then return 0 end
else
  return 0
end
redis.call('SET',KEYS[1],ARGV[2])
redis.call('ZREM',KEYS[2],ARGV[5])
return 1`;

const REPAIR_COMPLETED_TICKET_SCRIPT = `
local function validtype(key,expected)
  local value=redis.call('TYPE',key)
  local actual=type(value)=='table' and value.ok or value
  return actual=='none' or actual==expected
end
if not validtype(KEYS[1],'zset') or not validtype(KEYS[2],'zset')
  or not validtype(KEYS[3],'zset') or not validtype(KEYS[4],'zset')
  or not validtype(KEYS[5],'string') or not validtype(KEYS[6],'zset') then
  return redis.error_reply('after_sales_storage_type_error')
end
local completedScore=tonumber(ARGV[1]); local outboxScore=ARGV[3]=='1' and tonumber(ARGV[4]) or 0
if not completedScore or completedScore~=completedScore or completedScore<-9007199254740991 or completedScore>9007199254740991
  or not outboxScore or outboxScore~=outboxScore or outboxScore<-9007199254740991 or outboxScore>9007199254740991 then
  return redis.error_reply('after_sales_score_error')
end
redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2])
redis.call('ZREM',KEYS[2],ARGV[2])
redis.call('ZADD',KEYS[3],ARGV[1],ARGV[2])
if ARGV[3]=='1' then redis.call('ZADD',KEYS[4],ARGV[4],ARGV[2]) else redis.call('ZREM',KEYS[4],ARGV[2]) end
if redis.call('GET',KEYS[5])==ARGV[2] then redis.call('DEL',KEYS[5]) end
if ARGV[5]=='1' then redis.call('ZADD',KEYS[6],ARGV[1],ARGV[2]) else redis.call('ZREM',KEYS[6],ARGV[2]) end
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

function validTicketRecord(ticket, expectedId = "") {
  return Boolean(ticket && typeof ticket === "object" && !Array.isArray(ticket)
    && normalizeId(ticket.ticketId) && (!expectedId || normalizeId(ticket.ticketId) === expectedId)
    && ["pending", "completed"].includes(ticket.status)
    && [ticket.createdAt, ticket.completedAt, ticket.updatedAt].every((value) => value == null
      || value === ""
      || (typeof value === "string" && Number.isFinite(Date.parse(value)))));
}

async function readTicketRecord(ticketId) {
  const id = normalizeId(ticketId);
  if (!id) return { raw: null, ticket: null };
  const response = await redisPipeline([["GET", ticketKey(id)], ["PING"]]);
  if (!writeSucceeded(response, 2)) throw new Error("after_sales_store_unavailable");
  const rows = pipelineRows(response);
  if (pipelineValue(rows[1]) !== "PONG") throw new Error("after_sales_store_unavailable");
  const raw = pipelineValue(rows[0]);
  if (raw == null) return { raw: null, ticket: null };
  if (typeof raw !== "string") throw new Error("after_sales_store_unavailable");
  const ticket = parseRecord(raw);
  if (!validTicketRecord(ticket, id)) {
    console.warn("[after-sales] ignored invalid ticket record during single lookup", { ticketId: id });
    return { raw, ticket: null };
  }
  return { raw, ticket };
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

async function getTicketsByIds(ids, { invalidIds, missingIds } = {}) {
  const cleanIds = [];
  let invalidIndexCount = 0;
  (Array.isArray(ids) ? ids : []).forEach((value) => {
    const id = typeof value === "string" ? normalizeId(value) : "";
    if (id) cleanIds.push(id);
    else invalidIndexCount += 1;
  });
  if (invalidIndexCount) console.warn("[after-sales] skipped invalid ticket index member(s)", { count: invalidIndexCount });
  if (!cleanIds.length) return [];
  const response = await redisPipeline(cleanIds.map((id) => ["GET", ticketKey(id)]));
  const rows = pipelineRows(response);
  if (!writeSucceeded(response, cleanIds.length)) throw new Error("after_sales_store_unavailable");
  const tickets = [];
  const skippedIds = [];
  rows.forEach((entry, index) => {
    const expectedId = cleanIds[index];
    const raw = pipelineValue(entry), ticket = parseRecord(raw);
    if (raw == null) {
      skippedIds.push(expectedId);
      missingIds?.add?.(expectedId);
      return;
    }
    if (!validTicketRecord(ticket, cleanIds[index])) {
      skippedIds.push(expectedId);
      invalidIds?.add?.(expectedId);
      return;
    }
    if (ticket) tickets.push(ticket);
  });
  if (skippedIds.length) console.warn("[after-sales] skipped invalid ticket record(s)", {
    count: skippedIds.length, ticketIds: skippedIds.slice(0, 20),
  });
  return tickets;
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

async function readAfterSalesOutbox({ indexKey, pendingField, limit, errorCode, label }) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 30)));
  const pageSize = Math.min(200, Math.max(50, safeLimit * 2));
  const tickets = [];
  const staleMembers = new Set();
  const skippedTicketIds = [];
  let missingTicketCount = 0;
  let invalidIndexCount = 0;
  let offset = 0;

  // Defer index cleanup until the scan completes. Deleting members between
  // rank-based pages would shift later rows left and silently skip work.
  while (tickets.length < safeLimit) {
    const members = await redisCmd(["ZRANGE", indexKey, String(offset), String(offset + pageSize - 1)]);
    if (!Array.isArray(members)) throw new Error(errorCode);
    if (!members.length) break;

    const readable = [];
    for (const member of members) {
      const id = typeof member === "string" ? normalizeId(member) : "";
      if (!id) {
        invalidIndexCount += 1;
        if (typeof member === "string") staleMembers.add(member);
        continue;
      }
      readable.push({ id, member });
    }

    if (readable.length) {
      const response = await redisPipeline(readable.map(({ id }) => ["GET", ticketKey(id)]));
      if (!writeSucceeded(response, readable.length)) throw new Error(errorCode);
      const rows = pipelineRows(response);
      for (let index = 0; index < readable.length; index += 1) {
        const { id, member } = readable[index];
        const raw = pipelineValue(rows[index]);
        // A Redis GET result is a string or null. An object here is a malformed
        // transport response, not an independently corrupt stored JSON row.
        if (raw != null && typeof raw !== "string") throw new Error(errorCode);
        const ticket = parseRecord(raw);
        if (!validTicketRecord(ticket, id)) {
          staleMembers.add(member);
          skippedTicketIds.push(id);
          if (raw == null) missingTicketCount += 1;
        } else if (ticket[pendingField] === false) {
          staleMembers.add(member);
        } else if (tickets.length < safeLimit) {
          tickets.push(ticket);
        }
      }
    }

    offset += members.length;
    if (members.length < pageSize) break;
  }

  if (invalidIndexCount) console.warn(`[after-sales] skipped invalid ${label}-outbox index member(s)`, { count: invalidIndexCount });
  if (skippedTicketIds.length) console.warn(`[after-sales] skipped invalid or missing ${label}-outbox ticket record(s)`, {
    count: skippedTicketIds.length, missing: missingTicketCount, ticketIds: skippedTicketIds.slice(0, 20),
  });
  if (staleMembers.size) {
    const members = [...staleMembers];
    for (let start = 0; start < members.length; start += 200) {
      const commands = members.slice(start, start + 200).map((member) => ["ZREM", indexKey, member]);
      const cleanup = await redisPipeline(commands);
      if (!writeSucceeded(cleanup, commands.length)) throw new Error(errorCode);
    }
  }
  return tickets;
}

export async function getAfterSalesTicket(ticketId) {
  return (await readTicketRecord(ticketId)).ticket;
}

export async function getActiveAfterSalesTicket(orderId) {
  const key = activeOrderKey(orderId);
  if (!key) return null;
  const rawTicketId = await redisCmd(["GET", key]);
  if (rawTicketId && typeof rawTicketId === "object") {
    console.warn("[after-sales] ignored unreadable active-ticket index value", { orderId: normalizeId(orderId, 80) });
    return null;
  }
  const ticketId = normalizeId(rawTicketId);
  if (!ticketId) return null;
  const ticket = await getAfterSalesTicket(ticketId);
  if (ticket?.status === "pending" && normalizeId(ticket.orderId, 80) === normalizeId(orderId, 80)) return ticket;
  if (ticket?.status === "pending") return { ticketId, orderId: normalizeId(orderId, 80), status: "pending", storagePending: true };
  if (!ticket) return { ticketId, orderId: normalizeId(orderId, 80), status: "pending", storagePending: true };
  await compareDelete(key, ticketId);
  return null;
}

export async function getActiveAfterSalesTickets(orderIds) {
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).map((id) => normalizeId(id, 80)).filter(Boolean))];
  if (!ids.length || !redisConfig()) return {};
  const activeResponse = await redisPipeline(ids.map((orderId) => ["GET", activeOrderKey(orderId)]));
  const activeRows = pipelineRows(activeResponse);
  if (!writeSucceeded(activeResponse, ids.length)) throw new Error("after_sales_store_unavailable");
  let invalidActiveCount = 0;
  const activeIds = activeRows.map((entry) => {
    const raw = pipelineValue(entry);
    if (raw != null && typeof raw !== "string") { invalidActiveCount += 1; return ""; }
    return normalizeId(raw);
  });
  if (invalidActiveCount) console.warn("[after-sales] skipped invalid active-ticket index value(s)", { count: invalidActiveCount });
  const invalidTicketIds = new Set();
  const missingTicketIds = new Set();
  const records = await getTicketsByIds([...new Set(activeIds.filter(Boolean))], {
    invalidIds: invalidTicketIds,
    missingIds: missingTicketIds,
  });
  const byTicketId = new Map(records.map((ticket) => [normalizeId(ticket.ticketId), ticket]));
  const result = {};
  for (let index = 0; index < ids.length; index += 1) {
    const orderId = ids[index];
    const ticketId = activeIds[index];
    if (!ticketId) continue;
    const ticket = byTicketId.get(ticketId);
    if (ticket?.status === "pending" && normalizeId(ticket.orderId, 80) === orderId) result[orderId] = ticket;
    else if (invalidTicketIds.has(ticketId) || missingTicketIds.has(ticketId)) continue;
    else if (!ticket) result[orderId] = { ticketId, orderId, status: "pending", storagePending: true };
    else await compareDelete(activeOrderKey(orderId), ticketId);
  }
  return result;
}

function isCredentialService(service) {
  return CREDENTIAL_SERVICES.has(clean(service, 40).toLowerCase());
}

function normalizedService(value) {
  return clean(value, 40).toLowerCase();
}

function orderItemService(order, item, index) {
  return normalizedService(item?.service)
    || (index === 0 ? normalizedService(order?.service) : "");
}

function orderItemCredential(order, item, index, staffField, buyerField, maxLength) {
  const staffValue = clean(item?.[staffField], maxLength);
  if (staffValue) return staffValue;
  const buyerValue = clean(item?.[buyerField], maxLength);
  if (buyerValue) return buyerValue;
  if (index !== 0) return "";
  return clean(order?.[staffField], maxLength) || clean(order?.[buyerField], maxLength);
}

function orderCredentialItems(order) {
  if (Array.isArray(order?.items) && order.items.length) {
    return order.items.map((item, index) => ({
      ...item,
      service: orderItemService(order, item, index),
      account: clean(item?.account || (index === 0 ? order?.account : ""), 80),
      password: clean(item?.password || (index === 0 ? order?.password : ""), 120),
      staffAccount: clean(item?.staffAccount || (index === 0 ? order?.staffAccount : ""), 80),
      staffPassword: clean(item?.staffPassword || (index === 0 ? order?.staffPassword : ""), 120),
    }));
  }
  if (!order) return [];
  return [{
    service: normalizedService(order.service),
    account: clean(order.account, 80),
    password: clean(order.password, 120),
    staffAccount: clean(order.staffAccount, 80),
    staffPassword: clean(order.staffPassword, 120),
  }];
}

function orderCredentialFingerprint(order) {
  if (!order) return "";
  const snapshot = orderCredentialItems(order).map((item, index) => ({
    index,
    service: clean(item?.service, 40).toLowerCase(),
    account: clean(item?.account, 80),
    password: clean(item?.password, 120),
    staffAccount: clean(item?.staffAccount, 80),
    staffPassword: clean(item?.staffPassword, 120),
  }));
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export async function hydrateAfterSalesTicketCredentials(ticket) {
  if (!ticket) return null;
  const order = await getOrderById(ticket.orderId);
  const orderItems = orderCredentialItems(order);
  if (ticket.status !== "pending") {
    return {
      ...ticket,
      items: (Array.isArray(ticket.items) ? ticket.items : []).map((item, arrayIndex) => {
        const index = Number.isFinite(Number(item?.index)) ? Number(item.index) : arrayIndex;
        const source = orderItems[index] || {};
        const ticketService = normalizedService(item?.service);
        const sourceService = normalizedService(source.service);
        const service = ticketService || sourceService;
        if (ticketService && sourceService && ticketService !== sourceService) {
          return {
            ...item,
            index,
            service: ticketService,
            account: "",
            password: "",
            staffPassword: "",
            submittedPassword: "",
            currentPassword: "",
            credentialIdentityChanged: true,
          };
        }
        const netflixSelfService = service === "netflix" && (order
          ? order.netflixDeliveryMode === "self_service"
          : item?.netflixSelfService === true);
        return {
          ...item,
          index,
          service,
          netflixSelfService,
          ...(netflixSelfService ? {
            password: "",
            staffPassword: "",
            submittedPassword: "",
            currentPassword: "",
          } : {}),
        };
      }),
    };
  }
  return {
    ...ticket,
    credentialOrderHash: orderCredentialFingerprint(order),
    items: (Array.isArray(ticket.items) ? ticket.items : []).map((item, arrayIndex) => {
      const index = Number.isFinite(Number(item?.index)) ? Number(item.index) : arrayIndex;
      const source = orderItems[index] || {};
      const credentialManaged = Boolean(item.credentialManaged
        || isCredentialService(normalizedService(item.service) || source.service));
      if (!credentialManaged) return { ...item, index };
      const ticketService = normalizedService(item.service);
      const sourceService = normalizedService(source.service);
      const service = ticketService || sourceService;
      if (ticketService && sourceService && ticketService !== sourceService) {
        return {
          ...item,
          index,
          service: ticketService,
          credentialManaged: true,
          credentialIdentityChanged: true,
          account: "",
          password: "",
          staffPassword: "",
          submittedAccount: clean(item.account, 80),
          submittedPassword: "",
          currentAccount: "",
          currentPassword: "",
          applyCredentialsByDefault: false,
        };
      }
      const currentAccount = orderItemCredential(order, source, index, "staffAccount", "account", 80);
      const retainedPassword = orderItemCredential(order, source, index, "staffPassword", "password", 120);
      const netflixSelfService = service === "netflix" && (order
        ? order.netflixDeliveryMode === "self_service"
        : item?.netflixSelfService === true);
      const currentPassword = netflixSelfService ? "" : retainedPassword;
      // Spotify credentials are explicitly editable in the customer ticket
      // form, so its submitted values are intentional. Other credential
      // services are hidden from that form: their stored values are only a
      // creation-time snapshot and must not overwrite a newer order value.
      const customerSubmitted = item.customerCredentialEditable === true || service === "spotify";
      return {
        ...item,
        index,
        credentialManaged: true,
        netflixSelfService,
        customerCredentialEditable: customerSubmitted,
        submittedAccount: clean(item.account, 80),
        submittedPassword: netflixSelfService ? "" : clean(item.password, 120),
        currentAccount,
        currentPassword,
        account: customerSubmitted ? clean(item.account || currentAccount, 80) : currentAccount,
        password: netflixSelfService
          ? ""
          : customerSubmitted ? clean(item.password || currentPassword, 120) : currentPassword,
        ...(netflixSelfService ? { staffPassword: "" } : {}),
        applyCredentialsByDefault: customerSubmitted,
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
    "EVAL", CREATE_TICKET_SCRIPT, "6",
    ticketKey(ticketId), activeKey, ALL_INDEX, PENDING_INDEX, COMPLETED_INDEX, CREATION_OUTBOX_INDEX,
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
    const hasUpdate = submitted.has(index);
    const update = submitted.get(index) || {};
    const service = normalizedService(item?.service);
    const netflixSelfService = service === "netflix" && item?.netflixSelfService === true;
    const {
      submittedAccount: _submittedAccount,
      submittedPassword: _submittedPassword,
      currentAccount: _currentAccount,
      currentPassword: _currentPassword,
      applyCredentialsByDefault: _applyCredentialsByDefault,
      ...storedItem
    } = item;
    return {
      ...storedItem,
      index,
      service,
      credentialManaged: true,
      netflixSelfService,
      account: clean(update.account ?? item.account, 80),
      password: netflixSelfService ? "" : clean(update.password ?? item.password, 120),
      credentialsApplied: hasUpdate,
    };
  });
  if (items.some((item) => item.credentialsApplied && item.netflixSelfService && !validEmail(item.account))) {
    return { ok: false, error: "invalid_netflix_email" };
  }
  if (items.some((item) => item.credentialsApplied && !item.netflixSelfService && (!item.account || !item.password))) {
    return { ok: false, error: "missing_credentials" };
  }
  return { ok: true, items };
}

async function syncOrderCredentials(ticket, items, actor, operationId = "", requestHash = "", expectedCredentialHash = "") {
  const credentialItems = items.filter((item) => item.credentialsApplied
    && item.credentialManaged
    && item.account
    && (item.netflixSelfService || item.password));
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
  const stableCredentialHash = clean(expectedCredentialHash, 80);
  if (stableCredentialHash && orderCredentialFingerprint(order) !== stableCredentialHash) {
    return { ok: false, error: "stale_order_credentials" };
  }
  const expectedRevision = Number(order.revision ?? 0);
  if (!Array.isArray(order.items) || !order.items.length) {
    const source = credentialItems[0] || items[0] || {};
    order.items = [{
      service: normalizedService(order.service) || normalizedService(source.service),
      label: order.serviceLabel || source.label || "",
      cycle: order.cycle || "",
      amount: Number(order.finalAmount || 0),
      plan: order.plan || order.rocketPlan || source.plan || "",
      account: clean(order.account, 80),
      password: clean(order.password, 120),
      staffAccount: clean(order.staffAccount, 80),
      staffPassword: clean(order.staffPassword, 120),
    }];
  }

  const preservedCredentials = new Map();
  for (const item of credentialItems) {
    const index = Number(item.index);
    const target = Number.isFinite(index) ? order.items[index] : null;
    if (!target) return { ok: false, error: "order_item_not_found" };
    const service = normalizedService(item.service)
      || normalizedService(target.service)
      || (index === 0 ? normalizedService(order.service) : "");
    const targetService = orderItemService(order, target, index);
    if (service && targetService && service !== targetService) {
      return { ok: false, error: "order_item_identity_changed" };
    }
    preservedCredentials.set(index, {
      account: target.account || "",
      password: target.password || "",
      staffPassword: target.staffPassword || "",
    });
    if (item.netflixSelfService) {
      if (targetService !== "netflix" || order.netflixDeliveryMode !== "self_service" || !validEmail(item.account)) {
        return { ok: false, error: "invalid_netflix_email" };
      }
      // Only change the effective Netflix login email. Retained password fields
      // stay byte-for-byte unchanged so a later explicit switch back to manual
      // delivery still has the administrator's existing credential.
      target.staffAccount = item.account;
    } else if (service === "spotify") {
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

  if (credentialItems.some((item) => item.netflixSelfService)) {
    const netflixAccounts = order.items.flatMap((target, index) => {
      if (orderItemService(order, target, index) !== "netflix") return [];
      const account = orderItemCredential(order, target, index, "staffAccount", "account", 80)
        .toLowerCase();
      return [account];
    });
    if (!netflixAccounts.length || netflixAccounts.some((account) => !validEmail(account))) {
      return { ok: false, error: "invalid_netflix_email" };
    }
    if (new Set(netflixAccounts).size !== 1) {
      return { ok: false, error: "netflix_account_conflict" };
    }
  }

  if (order.items.length > 0) {
    // Top-level compatibility fields are always a mirror of items[0], not a
    // bundle-wide credential. Rebuild the mirror in the same CAS write after
    // any after-sales credential update so older readers cannot retain stale
    // values when the first item belongs to a multi-item order.
    const primaryItem = order.items[0];
    order.account = primaryItem?.account || "";
    order.password = primaryItem?.password || "";
    order.staffAccount = primaryItem?.staffAccount || "";
    order.staffPassword = primaryItem?.staffPassword || "";
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
    const service = normalizedService(item.service) || normalizedService(target.service);
    const preserved = preservedCredentials.get(Number(item.index)) || {};
    return item.netflixSelfService
      ? target.staffAccount === item.account
        && (target.account || "") === (preserved.account || "")
        && (target.password || "") === (preserved.password || "")
        && (target.staffPassword || "") === (preserved.staffPassword || "")
      : service === "spotify"
      ? target.account === item.account
        && target.password === item.password
        && !target.staffAccount
        && !target.staffPassword
      : target.staffAccount === item.account && target.staffPassword === item.password;
  });
  const persistedPrimary = persistedItems[0] || {};
  const primaryMirrorMatches = Boolean(persisted) && (
    (persisted.account || "") === (persistedPrimary.account || "")
    && (persisted.password || "") === (persistedPrimary.password || "")
    && (persisted.staffAccount || "") === (persistedPrimary.staffAccount || "")
    && (persisted.staffPassword || "") === (persistedPrimary.staffPassword || "")
  );
  return credentialsMatch && primaryMirrorMatches ? { ok: true } : { ok: false, error: "order_sync_failed" };
}

export async function completeAfterSalesTicket(ticketId, completion, actor) {
  const id = normalizeId(ticketId);
  const lockKey = COMPLETE_LOCK_PREFIX + id;
  const lockToken = randomBytes(12).toString("hex");
  const lockResponse = await redisPipeline([
    ["SET", lockKey, lockToken, "NX", "EX", "30"],
    ["PING"],
  ]);
  if (!writeSucceeded(lockResponse, 2)) return { ok: false, error: "after_sales_store_unavailable" };
  const lockRows = pipelineRows(lockResponse);
  if (pipelineValue(lockRows[1]) !== "PONG") return { ok: false, error: "after_sales_store_unavailable" };
  const locked = pipelineValue(lockRows[0]);
  if (locked == null) return { ok: false, error: "ticket_busy" };
  if (locked !== "OK") return { ok: false, error: "after_sales_store_unavailable" };
  try {
    const { raw: storedRaw, ticket: storedTicket } = await readTicketRecord(id);
    if (!validTicketRecord(storedTicket, id)) return { ok: false, error: "ticket_not_found" };
    const ticket = await hydrateAfterSalesTicketCredentials(storedTicket);
    const payload = completion && typeof completion === "object" ? completion : { staffNote: completion };
    const completionOperationId = clean(payload.operationId, 100);
    const completionRequestHash = clean(payload.requestHash, 80);
    if (ticket.status === "completed") {
      const owned = Boolean(completionOperationId && ticket.completionOperationId === completionOperationId);
      if (owned && ticket.completionRequestHash !== completionRequestHash) {
        return { ok: false, error: "idempotency_conflict" };
      }
      if (owned) {
        await redisCmd([
          "EVAL", REPAIR_COMPLETED_TICKET_SCRIPT, "6",
          ALL_INDEX, PENDING_INDEX, COMPLETED_INDEX, COMPLETION_OUTBOX_INDEX, activeOrderKey(ticket.orderId), CREATION_OUTBOX_INDEX,
          String(createdScore(ticket)), ticket.ticketId, ticket.completionEffectsPending ? "1" : "0", String(Date.now()), ticket.creationEffectsPending !== false ? "1" : "0",
        ]);
      }
      return { ok: true, ticket, changed: false, owned };
    }
    if (ticket.status !== "pending") return { ok: false, error: "invalid_ticket_status" };

    const merged = mergeCompletionItems(ticket, payload.items);
    if (!merged.ok) return merged;
    const synced = await syncOrderCredentials(
      ticket,
      merged.items,
      actor,
      completionOperationId,
      completionRequestHash,
      payload.credentialOrderHash,
    );
    if (!synced.ok) return synced;

    const now = new Date();
    const { credentialOrderHash: _credentialOrderHash, ...ticketRecord } = ticket;
    const completed = {
      ...ticketRecord,
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
      String(storedRaw), JSON.stringify(completed), completed.ticketId, String(score),
      completionOperationId || "__lm_after_sales_missing__", String(Date.now()), completionOperationId ? "1" : "0",
    ])) === 1;
    if (!saved) return { ok: false, error: "storage_failed" };
    return { ok: true, ticket: completed, changed: true, owned: Boolean(completionOperationId) };
  } finally {
    await compareDelete(lockKey, lockToken);
  }
}

export async function getAfterSalesCompletionOutbox(limit = 30) {
  return readAfterSalesOutbox({
    indexKey: COMPLETION_OUTBOX_INDEX,
    pendingField: "completionEffectsPending",
    limit,
    errorCode: "after_sales_store_unavailable",
    label: "completion",
  });
}

export async function backfillAfterSalesCreationOutbox(batchSize = 200) {
  const savedCursor = await redisCmd(["GET", CREATION_OUTBOX_BACKFILL_CURSOR]);
  if (savedCursor === "done") return { ok: true, done: true, processed: 0, indexed: 0 };
  const token = randomBytes(10).toString("hex");
  const locked = await redisCmd(["SET", CREATION_OUTBOX_BACKFILL_LOCK, token, "NX", "EX", "30"]);
  if (locked !== "OK") {
    const existingLock = await redisCmd(["GET", CREATION_OUTBOX_BACKFILL_LOCK]);
    return existingLock
      ? { ok: true, skipped: true, reason: "backfill_busy", processed: 0, indexed: 0 }
      : { ok: false, error: "creation_outbox_backfill_lock_unavailable", processed: 0, indexed: 0 };
  }
  try {
    const safeBatch = Math.max(1, Math.min(500, Number(batchSize || 200)));
    const cursor = Math.max(0, Number(savedCursor || 0));
    const ids = await redisCmd(["ZRANGE", ALL_INDEX, String(cursor), String(cursor + safeBatch - 1)]);
    if (!Array.isArray(ids)) throw new Error("after_sales_store_unavailable");
    const safeIds = [];
    let invalidIndexCount = 0;
    ids.forEach((value) => {
      const id = typeof value === "string" ? normalizeId(value) : "";
      if (id) safeIds.push(id);
      else invalidIndexCount += 1;
    });
    if (invalidIndexCount) console.warn("[after-sales] skipped invalid all-ticket index member(s) during creation-outbox backfill", { count: invalidIndexCount });
    const readResponse = safeIds.length ? await redisPipeline(safeIds.map((id) => ["GET", ticketKey(id)])) : [];
    if (!writeSucceeded(readResponse, safeIds.length)) throw new Error("after_sales_store_unavailable");
    const rawRows = pipelineRows(readResponse);
    const commands = [];
    let indexed = 0;
    const invalidTicketIds = [];
    safeIds.forEach((id, index) => {
      const raw = pipelineValue(rawRows[index]);
      const ticket = parseRecord(raw);
      if (!validTicketRecord(ticket, id)) {
        if (raw != null) invalidTicketIds.push(id);
        commands.push(["ZREM", CREATION_OUTBOX_INDEX, id]);
      } else if (ticket.creationEffectsPending !== false) {
        commands.push(["ZADD", CREATION_OUTBOX_INDEX, String(createdScore(ticket)), id]);
        indexed += 1;
      } else {
        commands.push(["ZREM", CREATION_OUTBOX_INDEX, id]);
      }
    });
    if (invalidTicketIds.length) console.warn("[after-sales] skipped invalid ticket record(s) during creation-outbox backfill", {
      count: invalidTicketIds.length, ticketIds: invalidTicketIds.slice(0, 20),
    });
    if (commands.length && !writeSucceeded(await redisPipeline(commands), commands.length)) throw new Error("creation_outbox_backfill_failed");
    const countResponse = await redisPipeline([["ZCARD", ALL_INDEX], ["PING"]]);
    if (!writeSucceeded(countResponse, 2)) throw new Error("after_sales_store_unavailable");
    const countRows = pipelineRows(countResponse), rawTotal = pipelineValue(countRows[0]), total = Number(rawTotal);
    if (pipelineValue(countRows[1]) !== "PONG"
      || !((typeof rawTotal === "number" && Number.isSafeInteger(rawTotal) && rawTotal >= 0)
        || (typeof rawTotal === "string" && /^\d+$/.test(rawTotal) && Number.isSafeInteger(total)))) {
      throw new Error("after_sales_store_unavailable");
    }
    const nextCursor = cursor + ids.length;
    const done = !ids.length || nextCursor >= total;
    if (await redisCmd(["SET", CREATION_OUTBOX_BACKFILL_CURSOR, done ? "done" : String(nextCursor)]) !== "OK") throw new Error("creation_outbox_backfill_failed");
    return { ok: true, done, processed: ids.length, indexed, cursor: nextCursor, total };
  } finally {
    await compareDelete(CREATION_OUTBOX_BACKFILL_LOCK, token);
  }
}

export async function getAfterSalesCreationOutbox(limit = 30) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 30)));
  // This incremental migration makes pre-index records enumerable without a
  // one-shot full scan. New tickets never depend on it because creation and
  // outbox insertion share the same Lua transaction above.
  const backfill = await backfillAfterSalesCreationOutbox();
  if (backfill?.ok === false) throw new Error(backfill.error || "creation_outbox_backfill_failed");
  return readAfterSalesOutbox({
    indexKey: CREATION_OUTBOX_INDEX,
    pendingField: "creationEffectsPending",
    limit: safeLimit,
    errorCode: "creation_outbox_unavailable",
    label: "creation",
  });
}

export async function markAfterSalesCreationEffectsDone(ticketId) {
  const id = normalizeId(ticketId);
  if (!id) return false;
  const completedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const raw = await redisCmd(["GET", ticketKey(id)]);
    const ticket = typeof raw === "string" ? parseRecord(raw) : null;
    if (!validTicketRecord(ticket, id)) return false;
    const nextRaw = replaceTopLevelJsonFields(raw, {
      creationEffectsPending: false,
      creationEffectsCompletedAt: completedAt,
    });
    if (!nextRaw) return false;
    const saved = Number(await redisCmd([
      "EVAL", MARK_EFFECTS_SCRIPT, "2", ticketKey(id), CREATION_OUTBOX_INDEX,
      raw, nextRaw, "creation", "-", id,
    ]));
    if (saved === 1) return true;
    if (saved !== -1) return false;
  }
  return false;
}

export async function markAfterSalesCompletionEffectsDone(ticketId, operationId) {
  const id = normalizeId(ticketId);
  const stableOperation = clean(operationId, 100);
  if (!id || !stableOperation) return false;
  const completedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const raw = await redisCmd(["GET", ticketKey(id)]);
    const ticket = typeof raw === "string" ? parseRecord(raw) : null;
    if (!validTicketRecord(ticket, id) || String(ticket.completionOperationId || "") !== stableOperation) return false;
    const nextRaw = replaceTopLevelJsonFields(raw, {
      completionEffectsPending: false,
      completionEffectsCompletedAt: completedAt,
    });
    if (!nextRaw) return false;
    const saved = Number(await redisCmd([
      "EVAL", MARK_EFFECTS_SCRIPT, "2", ticketKey(id), COMPLETION_OUTBOX_INDEX,
      raw, nextRaw, "completion", stableOperation, id,
    ]));
    if (saved === 1) return true;
    if (saved !== -1) return false;
  }
  return false;
}

export async function getAfterSalesCounts() {
  if (!redisConfig()) throw new Error("after_sales_store_unavailable");
  const response = await redisPipeline([
    ["ZCARD", ALL_INDEX],
    ["ZCARD", PENDING_INDEX],
    ["ZCARD", COMPLETED_INDEX],
    ["PING"],
  ]);
  if (!writeSucceeded(response, 4)) throw new Error("after_sales_store_unavailable");
  const rows = pipelineRows(response);
  const rawValues = rows.slice(0, 3).map(pipelineValue);
  const values = rawValues.map(Number);
  // audit-partial-failure: allow partial-failure-predicate-abort -- These are aggregate Redis counters, not independent business records; a malformed command result cannot be presented as a trustworthy count.
  if (pipelineValue(rows[3]) !== "PONG"
    || rawValues.some((value) => !((typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      || (typeof value === "string" && /^\d+$/.test(value))))
    || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("after_sales_store_unavailable");
  }
  return { all: values[0], pending: values[1], completed: values[2] };
}

async function scanAfterSalesTicketIndex(key, { status = "all", stopAfter = Infinity } = {}) {
  const records = [];
  const seen = new Set();
  const pageSize = 200;
  let offset = 0;
  let exhausted = false;
  while (records.length < stopAfter) {
    const ids = await redisCmd(["ZREVRANGE", key, String(offset), String(offset + pageSize - 1)]);
    if (!Array.isArray(ids)) throw new Error("after_sales_store_unavailable");
    if (!ids.length) { exhausted = true; break; }
    offset += ids.length;
    const tickets = await getTicketsByIds(ids);
    for (const ticket of tickets) {
      const ticketId = normalizeId(ticket.ticketId);
      if (!ticketId || seen.has(ticketId) || (status !== "all" && ticket.status !== status)) continue;
      seen.add(ticketId);
      records.push(ticket);
      if (records.length >= stopAfter) break;
    }
    if (ids.length < pageSize) { exhausted = true; break; }
  }
  return { records, exhausted };
}

export async function listAfterSalesTickets({ status = "all", query = "", offset = 0, limit = 60 } = {}) {
  const safeStatus = ["pending", "completed"].includes(status) ? status : "all";
  const parsedOffset = Number(offset);
  const parsedLimit = Number(limit);
  const safeOffset = Number.isFinite(parsedOffset) ? Math.max(0, Math.trunc(parsedOffset)) : 0;
  const safeLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, Math.trunc(parsedLimit))) : 60;
  const q = clean(query, 200).toLowerCase();
  const key = indexForStatus(safeStatus);
  const counts = await getAfterSalesCounts();

  if (!q) {
    const scanned = await scanAfterSalesTicketIndex(key, { status: safeStatus, stopAfter: safeOffset + safeLimit + 1 });
    const page = scanned.records.slice(safeOffset, safeOffset + safeLimit);
    const hasMore = scanned.records.length > safeOffset + safeLimit || !scanned.exhausted;
    const indexedTotal = Number(counts[safeStatus] ?? counts.all);
    const total = scanned.exhausted ? scanned.records.length : Math.max(scanned.records.length, indexedTotal);
    return { tickets: page.map(adminAfterSalesSummary), total, hasMore, counts };
  }

  // 搜索属于后台主动操作；只在搜索时读取记录，常规列表始终按索引分页。
  const { records } = await scanAfterSalesTicketIndex(key, { status: safeStatus });
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
