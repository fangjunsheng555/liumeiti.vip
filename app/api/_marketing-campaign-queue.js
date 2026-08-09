import { createHash, randomBytes } from "node:crypto";
import { readEmailDeliveryByMessageId, registerEmailDelivery } from "./_mail-delivery.js";
import { ensureMailContact, getMailSendDecision, mailContactId } from "./_mail-preferences.js";
import {
  clean,
  formatBeijingTime,
  mailFromAddress,
  pushAdminMailLog,
  redisCmd,
  redisPipeline,
  replaceTopLevelJsonFields,
  sendSimpleEmail,
  validEmail,
} from "./_utils.js";

const QUEUE_KEY = "lm:mail:marketing:queue";
const CAMPAIGN_PREFIX = "lm:mail:marketing:campaign:";
const JOB_PREFIX = "lm:mail:marketing:job:";
const CLAIM_PREFIX = "lm:mail:marketing:claim:";
const DISPATCH_LOCK_KEY = "lm:mail:marketing:dispatch-lock";
const DAILY_COUNT_PREFIX = "lm:mail:marketing:daily:";
const DAILY_ATTEMPT_PREFIX = "lm:mail:marketing:daily-attempt:";
const CAMPAIGN_INDEX_KEY = "lm:mail:marketing:campaign:index";
const CAMPAIGN_STATS_PREFIX = "lm:mail:marketing:campaign:stats:";
const CAMPAIGN_METRIC_EVENT_PREFIX = "lm:mail:marketing:campaign:metric-event:";
const RECIPIENT_PREFIX = "lm:mail:marketing:recipient:";
const RECIPIENT_INDEX_PREFIX = "lm:mail:marketing:recipients:";
const CAMPAIGN_JOB_INDEX_PREFIX = "lm:mail:marketing:jobs:";
const CAMPAIGN_PENDING_PREFIX = "lm:mail:marketing:pending:";
const RECORD_TTL_SECONDS = 90 * 24 * 60 * 60;
const CAMPAIGN_TTL_SECONDS = 400 * 24 * 60 * 60;
const METRIC_TTL_SECONDS = 2 * 365 * 24 * 60 * 60;
export const MARKETING_DAILY_LIMIT = 50;
export const MARKETING_RUNTIME_BATCH_LIMIT = 8;
const PROVIDER_COMMIT_RESERVE_MS = 4_000;
const PROVIDER_MIN_START_BUDGET_MS = 1_000;
const DISPATCH_RETURN_RESERVE_MS = 250;
const DAILY_LIMIT = MARKETING_DAILY_LIMIT;
const RETRY_DELAY_MS = 15 * 60 * 1000;
// Resend keeps idempotency keys for 24 hours. Leave two hours of scheduler and
// network headroom when recovering an attempt whose provider outcome is absent.
const RESEND_IDEMPOTENCY_RECOVERY_MS = 22 * 60 * 60 * 1000;
const DISPATCH_LOCK_TTL_SECONDS = 120;
const DISPATCH_LOCK_HEARTBEAT_MS = 40_000;
const ENQUEUE_CONCURRENCY = 12;
// 真实发送失败(非配额)累计到此上限后 job 永久置为 failed,不再无限重排
// (此前只有 45 天 TTL 兜底,永久无效地址会重试一个半月)。配额失败不计数。
const MAX_SEND_ATTEMPTS = 5;

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch (error) { return null; }
}

function pipelineRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (
    item && typeof item === "object" && Object.hasOwn(item, "result") ? item.result : item
  ));
}

async function readRedis(commands) {
  const response = await redisPipeline(commands);
  if (!Array.isArray(response) || response.length !== commands.length || response.some((item) => item?.error)) {
    return { ok: false, rows: [] };
  }
  const rows = pipelineRows(response);
  if (rows.some((item) => item && typeof item === "object" && item.error != null)) {
    return { ok: false, rows: [] };
  }
  return { ok: true, rows };
}

function flatObject(value) {
  if (value && !Array.isArray(value) && typeof value === "object") return value;
  const out = {};
  if (Array.isArray(value)) {
    for (let index = 0; index + 1 < value.length; index += 2) out[value[index]] = value[index + 1];
  }
  return out;
}

function safeCampaignId(value) {
  return clean(value, 80).replace(/[^A-Za-z0-9_-]/g, "");
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return validEmail(email) ? email : "";
}
function normalizeRecipients(value) { return (Array.isArray(value) ? value : [value]).map(normalizeEmail).filter(Boolean); }

function offerDispatchBlockReason(offer, now = Date.now()) {
  if (!offer || typeof offer !== "object" || Array.isArray(offer)) return "";
  const rawEndsAt = clean(offer.endsAt, 80);
  if (!rawEndsAt) return "";
  const endsAt = Date.parse(rawEndsAt);
  if (!Number.isFinite(endsAt)) return "invalid_offer_end";
  return endsAt <= Number(now) ? "offer_expired" : "";
}

function campaignKey(campaignId) { return CAMPAIGN_PREFIX + safeCampaignId(campaignId); }
function jobKey(jobId) { return JOB_PREFIX + clean(jobId, 80); }
function claimKey(jobId) { return CLAIM_PREFIX + clean(jobId, 80); }
function campaignStatsKey(campaignId) { return CAMPAIGN_STATS_PREFIX + safeCampaignId(campaignId); }
function recipientKey(campaignId, contactId) { return `${RECIPIENT_PREFIX}${safeCampaignId(campaignId)}:${clean(contactId, 64)}`; }
function recipientIndexKey(campaignId) { return RECIPIENT_INDEX_PREFIX + safeCampaignId(campaignId); }
function campaignJobIndexKey(campaignId) { return CAMPAIGN_JOB_INDEX_PREFIX + safeCampaignId(campaignId); }
function campaignPendingKey(campaignId) { return CAMPAIGN_PENDING_PREFIX + safeCampaignId(campaignId); }

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestFingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, run));
  return results;
}

function makeJobId(campaignId, email, scheduledAt) {
  return createHash("sha256")
    .update(`${safeCampaignId(campaignId)}\u0000${normalizeEmail(email)}\u0000${scheduledAt}`)
    .digest("hex")
    .slice(0, 32);
}

function deliveryMessageId(jobId) { return `marketing-queue-${clean(jobId, 80)}`; }

const CAMPAIGN_STATUSES = new Set(["draft", "scheduled", "sending", "paused", "completed", "cancelled", "failed"]);
const JOB_STATUSES = new Set(["queued", "sending", "submitted", "suppressed", "failed", "cancelled"]);
function plain(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function validCampaign(campaign, expectedId = "") {
  const id = safeCampaignId(campaign?.id);
  return plain(campaign) && Boolean(id) && id === campaign.id && (!expectedId || id === expectedId)
    && CAMPAIGN_STATUSES.has(campaign.status)
    && (!Object.hasOwn(campaign, "requestHash") || /^[a-f0-9]{64}$/i.test(String(campaign.requestHash)))
    && (!Object.hasOwn(campaign, "scheduledAt") || Number.isFinite(Date.parse(campaign.scheduledAt || "")));
}
function validNewCampaign(campaign, expectedId = "") {
  return validCampaign(campaign, expectedId) && /^[a-f0-9]{64}$/i.test(String(campaign.requestHash || ""))
    && typeof campaign.subject === "string" && typeof campaign.html === "string"
    && Number.isFinite(Date.parse(campaign.scheduledAt || ""));
}
function validJob(job, expectedId = "", expectedCampaignId = "", expectedTo = "", expectedScheduledAt = "") {
  const id = clean(job?.id, 80);
  const campaignId = safeCampaignId(job?.campaignId);
  const to = normalizeEmail(job?.to);
  const scheduledAt = String(job?.scheduledAt || "");
  return plain(job) && Boolean(id && campaignId && to) && JOB_STATUSES.has(job.status)
    && (!expectedId || id === expectedId) && (!expectedCampaignId || campaignId === expectedCampaignId)
    && (!expectedTo || to === normalizeEmail(expectedTo)) && (!expectedScheduledAt || scheduledAt === expectedScheduledAt)
    && makeJobId(campaignId, to, scheduledAt) === id && job.deliveryMessageId === deliveryMessageId(id)
    && Number.isFinite(Date.parse(scheduledAt));
}

function beijingDayKey(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

function nextBeijingDayStart(now = Date.now()) {
  const beijing = new Date(now + 8 * 60 * 60 * 1000);
  return Date.UTC(
    beijing.getUTCFullYear(),
    beijing.getUTCMonth(),
    beijing.getUTCDate() + 1,
  ) - 8 * 60 * 60 * 1000;
}

function dailyAttemptKey(job) {
  const attempts = Number(job?.attempts || 1);
  if (!validJob(job, clean(job?.id, 80)) || !Number.isSafeInteger(attempts) || attempts < 1) return "";
  return `${DAILY_ATTEMPT_PREFIX}${job.id}:${attempts}`;
}

function nextBeijingEvening(now = Date.now()) {
  const beijing = new Date(now + 8 * 60 * 60 * 1000);
  let result = Date.UTC(
    beijing.getUTCFullYear(),
    beijing.getUTCMonth(),
    beijing.getUTCDate(),
    10,
    30,
    0,
  );
  if (result <= now) result += 24 * 60 * 60 * 1000;
  return result;
}

function isQuotaFailure(result) {
  const message = `${result?.error || ""} ${result?.reason || ""}`.toLowerCase();
  return Number(result?.code || 0) === 429
    && /(daily_quota|monthly_quota|quota_exceeded)/.test(message);
}

function retryTimestamp(result, now = Date.now()) {
  return isQuotaFailure(result) ? nextBeijingEvening(now) : now + RETRY_DELAY_MS;
}

function providerOutcomeClass(result) {
  if (result?.suppressed) return "suppressed";
  if (result?.ok) return "success";
  if (result?.idempotencyConflict) return "idempotency_conflict";
  // A later definite response cannot prove that an earlier timeout, 5xx or
  // concurrent-idempotency response was not accepted by Resend. Preserve the
  // uncertainty window unless a later response is a success or an explicit
  // same-key/different-payload conflict.
  if (result?.uncertain) return "uncertain";
  if (isQuotaFailure(result)) return "quota";
  if (result?.policyUnavailable || result?.retryable) return "policy_retry";
  return "definite_failure";
}

function withoutProviderAttemptState(job) {
  const {
    providerAttemptStartedAt: _startedAt,
    resendIdempotencyDeadlineAt: _deadlineAt,
    ...rest
  } = job || {};
  return rest;
}

function ambiguousRecoveryScore(deadlineMs) {
  const safeDeadline = Number.isFinite(Number(deadlineMs))
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(deadlineMs))))
    : Number.MAX_SAFE_INTEGER;
  return Number.MIN_SAFE_INTEGER + safeDeadline;
}

function inflightRecoveryScore(startedMs) {
  const safeStarted = Number.isFinite(Number(startedMs))
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(startedMs))))
    : 0;
  return Number.MIN_SAFE_INTEGER + safeStarted;
}

const CREATE_CAMPAIGN_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'zset') then return '__storage_type__' end local score=tonumber(ARGV[2]); local ttl=tonumber(ARGV[4]) if not score or score~=score or not ttl or ttl~=math.floor(ttl) or ttl<1 then return '__invalid_args__' end local existing=redis.call('GET',KEYS[1]) if existing then local ok,doc=pcall(cjson.decode,existing) if not ok or type(doc)~='table' or tostring(doc.id or '')~=ARGV[3] then return -2 end if tostring(doc.requestHash or '')~=ARGV[1] then return -1 end redis.call('EXPIRE',KEYS[1],ARGV[4]) redis.call('ZADD',KEYS[2],'NX',ARGV[2],ARGV[3]) return 0 end local nextOk,nextDoc=pcall(cjson.decode,ARGV[5]) if not nextOk or type(nextDoc)~='table' or tostring(nextDoc.id or '')~=ARGV[3] or tostring(nextDoc.requestHash or '')~=ARGV[1] then return -2 end redis.call('SET',KEYS[1],ARGV[5],'EX',ARGV[4]) redis.call('ZADD',KEYS[2],'NX',ARGV[2],ARGV[3]) return 1
`;

const UPDATE_CAMPAIGN_STATE_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'zset') then return '__storage_type__' end local ttl=tonumber(ARGV[5]); local score=tonumber(ARGV[6]) if not ttl or ttl~=math.floor(ttl) or ttl<1 or not score or score~=score then return '__invalid_args__' end local raw=redis.call('GET',KEYS[1]) if not raw then return '__missing__' end if raw~=ARGV[3] then return '__conflict__' end local ok,doc=pcall(cjson.decode,raw) if not ok or type(doc)~='table' or tostring(doc.id or '')~=ARGV[7] then return '__corrupt__' end local current=tostring(doc.status or '') local allowed='|'..ARGV[2]..'|' if not string.find(allowed,'|'..current..'|',1,true) then return '__invalid__:'..current end local nextOk,nextDoc=pcall(cjson.decode,ARGV[4]) if not nextOk or type(nextDoc)~='table' or tostring(nextDoc.id or '')~=ARGV[7] or tostring(nextDoc.requestHash or '')~=tostring(doc.requestHash or '') or tostring(nextDoc.status or '')~=ARGV[1] then return '__corrupt_patch__' end redis.call('SET',KEYS[1],ARGV[4],'EX',ARGV[5]) redis.call('ZADD',KEYS[2],'NX',ARGV[6],ARGV[7]) return ARGV[4]
`;

const GUARDED_CAMPAIGN_STATE_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'zset') or not validtype(KEYS[3],'set') then return '__storage_type__' end local ttl=tonumber(ARGV[5]); local score=tonumber(ARGV[6]) if not ttl or ttl~=math.floor(ttl) or ttl<1 or not score or score~=score then return '__invalid_args__' end local raw=redis.call('GET',KEYS[1]) if not raw then return '__missing__' end if raw~=ARGV[3] then return '__conflict__' end local ok,doc=pcall(cjson.decode,raw) if not ok or type(doc)~='table' or tostring(doc.id or '')~=ARGV[7] then return '__corrupt__' end local current=tostring(doc.status or '') if current==ARGV[1] then return raw end local allowed='|'..ARGV[2]..'|' if not string.find(allowed,'|'..current..'|',1,true) then return '__invalid__:'..current end local pending=redis.call('SMEMBERS',KEYS[3]) for _,jobId in ipairs(pending) do if not validtype(ARGV[8]..jobId,'string') then return '__storage_type__' end local jobRaw=redis.call('GET',ARGV[8]..jobId) if jobRaw then local jobOk,job=pcall(cjson.decode,jobRaw) if not jobOk or type(job)~='table' or tostring(job.id or '')~=jobId or tostring(job.campaignId or '')~=ARGV[7] then return '__corrupt_job__' end if tostring(job.status or '')=='sending' and redis.call('EXISTS',ARGV[9]..jobId)==1 then return '__in_flight__' end end end local nextOk,nextDoc=pcall(cjson.decode,ARGV[4]) if not nextOk or type(nextDoc)~='table' or tostring(nextDoc.id or '')~=ARGV[7] or tostring(nextDoc.requestHash or '')~=tostring(doc.requestHash or '') or tostring(nextDoc.status or '')~=ARGV[1] then return '__corrupt_patch__' end redis.call('SET',KEYS[1],ARGV[4],'EX',ARGV[5]) redis.call('ZADD',KEYS[2],'NX',ARGV[6],ARGV[7]) return ARGV[4]
`;

const CLEAN_TERMINAL_JOB_REFERENCES_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'zset') or not validtype(KEYS[3],'set') then return '__storage_type__' end local raw=redis.call('GET',KEYS[1]) if raw then local ok,doc=pcall(cjson.decode,raw) if not ok or type(doc)~='table' or tostring(doc.id or '')~=ARGV[1] or tostring(doc.campaignId or '')~=ARGV[2] then return '__corrupt__' end local status=tostring(doc.status or '') if status~='submitted' and status~='suppressed' and status~='failed' and status~='cancelled' then return '__active__:'..status end end redis.call('ZREM',KEYS[2],ARGV[1]) redis.call('SREM',KEYS[3],ARGV[1]) redis.call('DEL',KEYS[4]) if raw then return '__terminal__' end return '__missing__'
`;

async function createCampaign(campaign) {
  if (!validNewCampaign(campaign, safeCampaignId(campaign?.id))) return { ok: false, error: "invalid_campaign" };
  const score = Number(campaign.createdAtMs || Date.now());
  const campaignRaw = JSON.stringify(campaign);
  const result = await redisCmd([
    "EVAL",
    CREATE_CAMPAIGN_SCRIPT,
    "2",
    campaignKey(campaign.id),
    CAMPAIGN_INDEX_KEY,
    campaign.requestHash,
    String(score),
    campaign.id,
    String(CAMPAIGN_TTL_SECONDS),
    campaignRaw,
  ]);
  if (result === 1 || result === "1") return { ok: true, created: true };
  if (result === 0 || result === "0") return { ok: true, created: false, duplicate: true };
  if (result === -1 || result === "-1") return { ok: false, error: "campaign_conflict" };
  if (result != null) return { ok: false, error: "storage_failed" };

  const recovery = await readRedis([
    ["GET", campaignKey(campaign.id)],
    ["ZSCORE", CAMPAIGN_INDEX_KEY, campaign.id],
    ["PING"],
  ]);
  const recovered = parseJson(recovery.rows[0]);
  if (recovery.ok && recovery.rows[2] === "PONG" && recovery.rows[1] != null
      && validCampaign(recovered, campaign.id) && recovered.requestHash === campaign.requestHash) {
    const created = recovery.rows[0] === campaignRaw && Number(recovery.rows[1]) === score;
    return { ok: true, created, duplicate: !created, recovered: true };
  }
  return { ok: false, error: "storage_failed" };
}

async function updateCampaignState(campaignId, status, expectedStatuses, patch = {}) {
  const id = safeCampaignId(campaignId);
  if (!id) return { ok: false, error: "campaign_not_found" };
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await readRedis([["GET", campaignKey(id)], ["PING"]]);
    if (!read.ok || read.rows[1] !== "PONG") return { ok: false, error: "storage_failed" };
    const raw = read.rows[0];
    if (raw == null) return { ok: false, error: "campaign_not_found" };
    const current = typeof raw === "string" ? parseJson(raw) : null;
    if (!validCampaign(current, id)) return { ok: false, error: "storage_failed" };
    const nextRaw = replaceTopLevelJsonFields(raw, { ...patch, updatedAt: now, status });
    if (!nextRaw) return { ok: false, error: "storage_failed" };
    const result = await redisCmd([
      "EVAL", UPDATE_CAMPAIGN_STATE_SCRIPT, "2",
      campaignKey(id), CAMPAIGN_INDEX_KEY,
      status, expectedStatuses.join("|"), raw, nextRaw,
      String(CAMPAIGN_TTL_SECONDS), String(Date.now()), id,
    ]);
    if (result === "__conflict__") continue;
    if (result === "__missing__") return { ok: false, error: "campaign_not_found" };
    if (String(result || "").startsWith("__invalid__")) return { ok: false, error: "invalid_status_transition" };
    const campaign = parseJson(result);
    return validCampaign(campaign, id) ? { ok: true, campaign } : { ok: false, error: "storage_failed" };
  }
  return { ok: false, error: "storage_conflict" };
}

async function updateCampaignStateGuarded(campaignId, status, expectedStatuses, patch = {}) {
  const id = safeCampaignId(campaignId);
  if (!id) return { ok: false, error: "campaign_not_found" };
  const updatedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await readRedis([["GET", campaignKey(id)], ["PING"]]);
    if (!read.ok || read.rows[1] !== "PONG") return { ok: false, error: "storage_failed" };
    const raw = read.rows[0];
    if (raw == null) return { ok: false, error: "campaign_not_found" };
    const current = typeof raw === "string" ? parseJson(raw) : null;
    if (!validCampaign(current, id)) return { ok: false, error: "storage_failed" };
    if (String(current.status || "") === status) return { ok: true, campaign: current };
    const nextRaw = replaceTopLevelJsonFields(raw, { ...patch, updatedAt, status });
    if (!nextRaw) return { ok: false, error: "storage_failed" };
    const result = await redisCmd([
      "EVAL", GUARDED_CAMPAIGN_STATE_SCRIPT, "3",
      campaignKey(id), CAMPAIGN_INDEX_KEY, campaignPendingKey(id),
      status, expectedStatuses.join("|"), raw, nextRaw,
      String(CAMPAIGN_TTL_SECONDS), String(Date.now()), id, JOB_PREFIX, CLAIM_PREFIX,
    ]);
    if (result === "__conflict__") continue;
    if (result === "__missing__") return { ok: false, error: "campaign_not_found" };
    if (result === "__in_flight__") return { ok: false, error: "campaign_in_flight" };
    if (String(result || "").startsWith("__invalid__")) return { ok: false, error: "invalid_status_transition" };
    const campaign = parseJson(result);
    return validCampaign(campaign, id) ? { ok: true, campaign } : { ok: false, error: "storage_failed" };
  }
  return { ok: false, error: "storage_conflict" };
}

export async function getMarketingCampaign(campaignId) {
  const id = safeCampaignId(campaignId);
  if (!id) return null;
  const campaign = parseJson(await redisCmd(["GET", campaignKey(id)]));
  return validCampaign(campaign, id) ? campaign : null;
}

export async function readMarketingCampaign(campaignId) {
  const id = safeCampaignId(campaignId);
  if (!id) return { ok: true, campaign: null };
  const response = await readRedis([["GET", campaignKey(id)]]);
  if (!response.ok) return { ok: false, error: "storage_unavailable", campaign: null };
  if (response.rows[0] == null) return { ok: true, campaign: null };
  const campaign = parseJson(response.rows[0]);
  return validCampaign(campaign, id)
    ? { ok: true, campaign }
    : { ok: false, error: "storage_corrupt", campaign: null };
}

export async function listMarketingCampaigns({ limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(300, Number(limit || 100)));
  const pageSize = Math.max(50, Math.min(300, safeLimit * 2));
  const campaigns = [], seen = new Set(), skippedIds = [];
  let invalidIndexMembers = 0;
  let offset = 0;
  while (campaigns.length < safeLimit) {
    const indexRead = await readRedis([["ZREVRANGE", CAMPAIGN_INDEX_KEY, String(offset), String(offset + pageSize - 1)]]);
    if (!indexRead.ok || !Array.isArray(indexRead.rows[0])) throw new Error("marketing_campaign_storage_unavailable");
    const rawIds = indexRead.rows[0];
    if (!rawIds.length) break;
    const ids = [];
    rawIds.forEach((value) => {
      const id = safeCampaignId(value);
      if (!id || id !== value || seen.has(id)) { invalidIndexMembers += 1; return; }
      seen.add(id);
      ids.push(id);
    });
    if (ids.length) {
      const campaignRead = await readRedis(ids.map((id) => ["GET", campaignKey(id)]));
      if (!campaignRead.ok) throw new Error("marketing_campaign_storage_unavailable");
      campaignRead.rows.forEach((raw, index) => {
        const campaign = parseJson(raw);
        if (validCampaign(campaign, ids[index])) campaigns.push(campaign);
        else skippedIds.push(ids[index]);
      });
    }
    offset += rawIds.length;
    if (rawIds.length < pageSize) break;
  }
  if (invalidIndexMembers) console.warn("[marketing-campaign] skipped invalid campaign index members", { skipped: invalidIndexMembers });
  if (skippedIds.length) console.warn("[marketing-campaign] skipped unreadable campaign records", {
    skipped: skippedIds.length, ids: skippedIds.slice(0, 10),
  });
  return campaigns.slice(0, safeLimit);
}

async function readCampaignJobs(campaignId) {
  const id = safeCampaignId(campaignId);
  const index = await readRedis([
    ["SMEMBERS", campaignPendingKey(id)], ["SMEMBERS", campaignJobIndexKey(id)], ["PING"],
  ]);
  if (!index.ok || !Array.isArray(index.rows[0]) || !Array.isArray(index.rows[1]) || index.rows[2] !== "PONG") return null;
  const rawIds = [...index.rows[0], ...index.rows[1]];
  const jobIds = Array.from(new Set(rawIds.map((value) => clean(value, 80))));
  if (jobIds.some((jobId) => !jobId) || rawIds.some((value) => !jobIds.includes(value))) return null;
  if (!jobIds.length) return [];
  const read = await readRedis([...jobIds.map((jobId) => ["GET", jobKey(jobId)]), ["PING"]]);
  if (!read.ok || read.rows.at(-1) !== "PONG") return null;
  const snapshots = jobIds.map((jobId, index) => ({ id: jobId, raw: read.rows[index], job: parseJson(read.rows[index]) }));
  return snapshots.some(({ raw, job, id: jobId }) => raw != null && !validJob(job, jobId, id)) ? null : snapshots;
}

export async function updateMarketingCampaignStatus(campaignId, status, actor = null) {
  const transitions = {
    paused: ["scheduled", "sending"],
    scheduled: ["paused"],
    cancelled: ["draft", "scheduled", "sending", "paused"],
  };
  if (!transitions[status]) return { ok: false, error: "invalid_status" };
  const updatedBy = actor ? {
    staffId: Number(actor.staffId || 1),
    staffUsername: clean(actor.staffUsername || "admin", 60),
  } : null;
  const snapshots = status === "cancelled" ? await readCampaignJobs(campaignId) : [];
  if (snapshots == null) return { ok: false, error: "storage_failed", cancelledJobs: 0 };
  const result = await updateCampaignStateGuarded(campaignId, status, transitions[status], {
    ...(updatedBy ? { updatedBy } : {}),
    ...(status === "cancelled" ? { cancelledAt: new Date().toISOString() } : {}),
  });
  if (!result.ok || status !== "cancelled") return result;
  if (!snapshots.length) return { ...result, cancelledJobs: 0 };

  const outcomes = await mapWithConcurrency(snapshots, ENQUEUE_CONCURRENCY, async ({ id, job }) => {
    if (!job) return { ok: true, cleanup: true, cancelled: false };
    if (["submitted", "suppressed", "failed"].includes(job.status)) {
      return { ok: true, cleanup: true, cancelled: false };
    }
    if (job.status === "cancelled") {
      const recipient = await updateRecipientStatusStrict(job, "cancelled");
      return { ok: recipient.ok, cleanup: true, cancelled: true };
    }
    if (!["queued", "sending"].includes(job.status)) return { ok: false, cleanup: false, cancelled: false };

    const now = new Date().toISOString();
    const transitioned = await transitionJob({
      ...job,
      status: "cancelled",
      cancelledAt: now,
      updatedAt: now,
    }, {
      expectedStatuses: ["queued", "sending"],
      mode: "terminal",
    });
    if (!transitioned.ok) return { ok: false, cleanup: false, cancelled: false };
    const recipient = await updateRecipientStatusStrict(job, "cancelled");
    return { ok: recipient.ok, cleanup: false, cancelled: true, transitioned: true };
  });

  const cleanupIds = snapshots
    .filter((_, index) => outcomes[index]?.cleanup)
    .map(({ id }) => id);
  let cleanupOk = true;
  if (cleanupIds.length) {
    const cleanupRead = await readRedis(cleanupIds.map((id) => [
      "EVAL",
      CLEAN_TERMINAL_JOB_REFERENCES_SCRIPT,
      "4",
      jobKey(id),
      QUEUE_KEY,
      campaignPendingKey(campaignId),
      claimKey(id),
      id,
      safeCampaignId(campaignId),
    ]));
    cleanupOk = cleanupRead.ok && cleanupRead.rows.every((row) => row === "__terminal__" || row === "__missing__");
  }

  const cancelledJobs = outcomes.filter((outcome) => outcome?.transitioned).length;
  const totalCancelledJobs = outcomes.filter((outcome) => outcome?.cancelled).length;
  if (outcomes.some((outcome) => !outcome?.ok) || !cleanupOk) {
    return { ok: false, error: "storage_failed", campaign: result.campaign, cancelledJobs };
  }
  if (totalCancelledJobs) {
    const metric = await recordMarketingCampaignMetric(
      campaignId,
      "cancelled",
      `cancel:${result.campaign.cancelledAt}`,
      totalCancelledJobs,
    );
    if (!metric.ok) return { ok: false, error: "storage_failed", campaign: result.campaign, cancelledJobs };
  }
  return { ...result, cancelledJobs };
}

const CAMPAIGN_METRICS = new Set([
  "queued", "submitted", "delivered", "delayed", "bounced", "complained", "suppressed",
  "failed", "cancelled", "unsubscribed", "uniqueClicks", "linkHits",
]);

const RECORD_CAMPAIGN_METRIC_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end if (ARGV[1]~='0' and not validtype(KEYS[1],'string')) or not validtype(KEYS[2],'hash') then return '__storage_type__' end local ttl=tonumber(ARGV[4]); local amount=tonumber(ARGV[5]) if not ttl or ttl~=math.floor(ttl) or ttl<1 or ttl>2147483647 or not amount or amount~=amount then return '__invalid_args__' end if ARGV[1]~='0' then if redis.call('EXISTS',KEYS[1])==1 then return '__duplicate__' end end local value if ARGV[3]=='integer' then if amount~=math.floor(amount) or amount<-9007199254740991 or amount>9007199254740991 then return '__invalid_args__' end local currentRaw=redis.call('HGET',KEYS[2],ARGV[2]); local current=0 if currentRaw then current=tonumber(currentRaw) end if not current or current~=math.floor(current) or current<-9007199254740991 or current>9007199254740991 or current+amount<-9007199254740991 or current+amount>9007199254740991 then return '__invalid_metric__' end value=redis.call('HINCRBY',KEYS[2],ARGV[2],amount) else local currentRaw=redis.call('HGET',KEYS[2],ARGV[2]); local current=0 if currentRaw then current=tonumber(currentRaw) end if not current or current~=current or current+amount~=current+amount or current+amount==math.huge or current+amount==-math.huge then return '__invalid_metric__' end value=redis.call('HINCRBYFLOAT',KEYS[2],ARGV[2],amount) end if ARGV[1]~='0' then redis.call('SET',KEYS[1],'1','EX',ttl) end redis.call('EXPIRE',KEYS[2],ARGV[4]) return tostring(value)
`;

export async function recordMarketingCampaignMetric(campaignId, metric, eventId = "", amount = 1) {
  const id = safeCampaignId(campaignId);
  const safeMetric = clean(metric, 40).replace(/[^A-Za-z0-9_-]/g, "");
  if (!id || !CAMPAIGN_METRICS.has(safeMetric)) return { ok: false, error: "invalid_metric" };
  const fingerprint = eventId
    ? createHash("sha256").update(`${id}\u0000${safeMetric}\u0000${eventId}`).digest("hex")
    : "";
  const increment = Number(amount || 0);
  if (!Number.isFinite(increment) || Math.abs(increment) > Number.MAX_SAFE_INTEGER
    || (Number.isInteger(increment) && !Number.isSafeInteger(increment))) {
    return { ok: false, error: "invalid_metric" };
  }
  const result = await redisCmd([
    "EVAL",
    RECORD_CAMPAIGN_METRIC_SCRIPT,
    "2",
    fingerprint ? CAMPAIGN_METRIC_EVENT_PREFIX + fingerprint : campaignStatsKey(id),
    campaignStatsKey(id),
    fingerprint || "0",
    safeMetric,
    Number.isInteger(increment) ? "integer" : "float",
    String(METRIC_TTL_SECONDS),
    String(increment),
  ]);
  if (result === "__duplicate__") return { ok: true, duplicate: true };
  if (result === "__invalid_args__" || result === "__invalid_metric__") {
    return { ok: false, error: "invalid_metric" };
  }
  if (result == null || (typeof result === "string" && result.startsWith("__"))) {
    return { ok: false, error: "storage_failed" };
  }
  const value = Number(result);
  return Number.isFinite(value)
    ? { ok: true, value }
    : { ok: false, error: "storage_failed" };
}

export async function getMarketingCampaignCounters(campaignId) {
  const result = await getMarketingCampaignCountersBatch([campaignId]);
  return result.ok ? (result.byId[safeCampaignId(campaignId)] || {}) : {};
}

export async function getMarketingCampaignCountersBatch(campaignIds) {
  const ids = Array.from(new Set((Array.isArray(campaignIds) ? campaignIds : []).map(safeCampaignId).filter(Boolean))).slice(0, 300);
  if (!ids.length) return { ok: true, byId: {} };
  const response = await readRedis(ids.map((id) => ["HGETALL", campaignStatsKey(id)]));
  if (!response.ok) return { ok: false, error: "storage_failed", byId: {} };
  const byId = {};
  ids.forEach((id, index) => {
    const raw = flatObject(response.rows[index]);
    byId[id] = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Number(value || 0)]));
  });
  return { ok: true, byId };
}

const SAVE_JOB_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'zset') or not validtype(KEYS[3],'set') or not validtype(KEYS[4],'set') then return -3 end local score=tonumber(ARGV[1]); local recordTtl=tonumber(ARGV[3]); local campaignTtl=tonumber(ARGV[4]) if not score or score~=score or score<-9007199254740991 or score>9007199254740991 or not recordTtl or recordTtl~=math.floor(recordTtl) or recordTtl<1 or recordTtl>2147483647 or not campaignTtl or campaignTtl~=math.floor(campaignTtl) or campaignTtl<1 or campaignTtl>2147483647 then return -3 end local nextOk,nextDoc=pcall(cjson.decode,ARGV[5]) if not nextOk or type(nextDoc)~='table' or tostring(nextDoc.id or '')~=ARGV[2] then return -3 end local existing=redis.call('GET',KEYS[1]) if existing then local ok,doc=pcall(cjson.decode,existing) if not ok or type(doc)~='table' or tostring(doc.id or '')~=ARGV[2] or tostring(doc.campaignId or '')~=tostring(nextDoc.campaignId or '') or tostring(doc.to or '')~=tostring(nextDoc.to or '') or tostring(doc.scheduledAt or '')~=tostring(nextDoc.scheduledAt or '') or tostring(doc.deliveryMessageId or '')~=tostring(nextDoc.deliveryMessageId or '') then return -2 end local status=tostring(doc.status or '') local queueScore=tonumber(doc.queueScore or ARGV[1]) if not queueScore or queueScore~=queueScore or queueScore<-9007199254740991 or queueScore>9007199254740991 then return -2 end redis.call('SADD',KEYS[3],ARGV[2]) redis.call('EXPIRE',KEYS[3],ARGV[4]) if status=='queued' or status=='sending' then redis.call('ZADD',KEYS[2],queueScore,ARGV[2]) redis.call('SADD',KEYS[4],ARGV[2]) redis.call('EXPIRE',KEYS[4],ARGV[4]) else redis.call('ZREM',KEYS[2],ARGV[2]) redis.call('SREM',KEYS[4],ARGV[2]) end redis.call('EXPIRE',KEYS[1],ARGV[3]) return 0 end redis.call('SET',KEYS[1],ARGV[5],'EX',ARGV[3]) redis.call('ZADD',KEYS[2],ARGV[1],ARGV[2]) redis.call('SADD',KEYS[3],ARGV[2]) redis.call('SADD',KEYS[4],ARGV[2]) redis.call('EXPIRE',KEYS[3],ARGV[4]) redis.call('EXPIRE',KEYS[4],ARGV[4]) return 1
`;

async function saveJob(job, score) {
  if (!validJob(job, job?.id, safeCampaignId(job?.campaignId))) return { ok: false, error: "invalid_job_record" };
  const queueScore = Number(score);
  const raw = JSON.stringify({ ...job, queueScore });
  const result = await redisCmd([
    "EVAL",
    SAVE_JOB_SCRIPT,
    "4",
    jobKey(job.id),
    QUEUE_KEY,
    campaignJobIndexKey(job.campaignId),
    campaignPendingKey(job.campaignId),
    String(queueScore),
    job.id,
    String(RECORD_TTL_SECONDS),
    String(CAMPAIGN_TTL_SECONDS),
    raw,
  ]);
  if (result === 1 || result === "1") return { ok: true, created: true };
  if (result === 0 || result === "0") return { ok: true, created: false, duplicate: true };
  if (result != null) return { ok: false, error: "storage_failed" };
  const recovery = await readRedis([
    ["GET", jobKey(job.id)], ["ZSCORE", QUEUE_KEY, job.id],
    ["SISMEMBER", campaignJobIndexKey(job.campaignId), job.id],
    ["SISMEMBER", campaignPendingKey(job.campaignId), job.id], ["PING"],
  ]);
  const active = ["queued", "sending"].includes(job.status);
  if (recovery.ok && recovery.rows[0] === raw && Number(recovery.rows[2]) === 1
      && recovery.rows[4] === "PONG"
      && (active ? Number(recovery.rows[1]) === queueScore && Number(recovery.rows[3]) === 1
        : recovery.rows[1] == null && Number(recovery.rows[3]) === 0)) {
    return { ok: true, created: true, recovered: true };
  }
  return { ok: false, error: "storage_failed" };
}

function campaignTransitionDocuments(raw, job, mode, timestamp) {
  const emptyResponse = JSON.stringify({ ok: true, status: job.status, campaignStatus: "" });
  if (typeof raw !== "string") {
    return {
      expectedRaw: "__lm_marketing_missing__",
      campaignNextRaw: "__lm_marketing_missing__",
      campaignFinalRaw: "__lm_marketing_missing__",
      responseNext: emptyResponse,
      responseFinal: emptyResponse,
    };
  }
  const campaign = parseJson(raw);
  if (!validCampaign(campaign, safeCampaignId(job?.campaignId))) {
    return {
      expectedRaw: raw,
      campaignNextRaw: "__lm_marketing_missing__",
      campaignFinalRaw: "__lm_marketing_missing__",
      responseNext: emptyResponse,
      responseFinal: emptyResponse,
    };
  }
  const patch = { updatedAt: timestamp };
  if (job.status === "sending" && String(campaign.status || "") === "scheduled") {
    patch.status = "sending";
    if (!Object.hasOwn(campaign, "startedAt") || campaign.startedAt === false) patch.startedAt = timestamp;
  }
  if (mode === "terminal") {
    const field = `${job.status}Count`;
    const count = Number(campaign[field] ?? 0);
    const terminalCount = Number(campaign.terminalCount ?? 0);
    if (!Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(terminalCount) || terminalCount < 0 || terminalCount >= Number.MAX_SAFE_INTEGER) return null;
    patch[field] = count + 1;
    patch.terminalCount = terminalCount + 1;
  }
  const campaignNextRaw = replaceTopLevelJsonFields(raw, patch);
  if (!campaignNextRaw) return null;
  const nextStatus = String(patch.status ?? campaign.status ?? "");
  const finalPatch = { ...patch };
  if (mode === "terminal" && campaign.enqueueCompletedAt && nextStatus !== "cancelled") {
    const failedCount = Number(finalPatch.failedCount ?? campaign.failedCount ?? 0);
    const enqueueFailedCount = Number(campaign.enqueueFailedCount ?? 0);
    if (!Number.isSafeInteger(failedCount) || failedCount < 0
      || !Number.isSafeInteger(enqueueFailedCount) || enqueueFailedCount < 0) return null;
    if (failedCount > 0 || enqueueFailedCount > 0) {
      finalPatch.status = "failed";
      finalPatch.failedAt = timestamp;
    } else {
      finalPatch.status = "completed";
      finalPatch.completedAt = timestamp;
    }
  }
  const campaignFinalRaw = replaceTopLevelJsonFields(raw, finalPatch);
  if (!campaignFinalRaw) return null;
  return {
    expectedRaw: raw,
    campaignNextRaw,
    campaignFinalRaw,
    responseNext: JSON.stringify({ ok: true, status: job.status, campaignStatus: nextStatus }),
    responseFinal: JSON.stringify({
      ok: true,
      status: job.status,
      campaignStatus: String(finalPatch.status ?? campaign.status ?? ""),
    }),
  };
}

const TRANSITION_JOB_SCRIPT = `
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end local expectedTypes={'string','zset','set','string','set','string','zset','string'} for index,key in ipairs(KEYS) do if not validtype(key,expectedTypes[index]) then return '__storage_type__' end end local recordTtl=tonumber(ARGV[3]); local campaignTtl=tonumber(ARGV[4]); local queueScore=tonumber(ARGV[6]); local dailyTtl=tonumber(ARGV[12]); local campaignScore=tonumber(ARGV[13]) if not recordTtl or recordTtl~=math.floor(recordTtl) or recordTtl<1 or not campaignTtl or campaignTtl~=math.floor(campaignTtl) or campaignTtl<1 or not queueScore or queueScore~=queueScore or queueScore<-9007199254740991 or queueScore>9007199254740991 or not dailyTtl or dailyTtl~=math.floor(dailyTtl) or dailyTtl<1 or not campaignScore or campaignScore~=campaignScore or campaignScore<-9007199254740991 or campaignScore>9007199254740991 then return '__invalid_args__' end if ARGV[11]=='1' then local dailyRaw=redis.call('GET',KEYS[8]); local dailyCount=dailyRaw and tonumber(dailyRaw) or 0 if not dailyCount or dailyCount~=math.floor(dailyCount) or dailyCount<0 or dailyCount>=9007199254740991 then return '__invalid_daily_count__' end end local raw=redis.call('GET',KEYS[1]) if not raw then return '__missing__' end local ok,current=pcall(cjson.decode,raw) if not ok or type(current)~='table' or tostring(current.id or '')~=ARGV[8] or tostring(current.campaignId or '')~=ARGV[7] then return '__corrupt__' end local currentStatus=tostring(current.status or '') local expected='|'..ARGV[1]..'|' if not string.find(expected,'|'..currentStatus..'|',1,true) then return '__invalid__:'..currentStatus end local campaignRaw=redis.call('GET',KEYS[6]) if campaignRaw then if campaignRaw~=ARGV[14] then return '__campaign_conflict__' end elseif ARGV[14]~='__lm_marketing_missing__' then return '__campaign_conflict__' end local campaign=nil if campaignRaw then local campaignOk,decoded=pcall(cjson.decode,campaignRaw) if not campaignOk or type(decoded)~='table' or tostring(decoded.id or '')~=ARGV[7] then return '__campaign_corrupt__' end campaign=decoded end if ARGV[9]=='sending' then if not campaign then return '__campaign_missing__' end local campaignStatus=tostring(campaign.status or '') if campaignStatus~='scheduled' and campaignStatus~='sending' then return '__campaign_blocked__:'..campaignStatus end end local nextOk,nextDoc=pcall(cjson.decode,ARGV[2]) if not nextOk or type(nextDoc)~='table' or tostring(nextDoc.id or '')~=ARGV[8] or tostring(nextDoc.campaignId or '')~=ARGV[7] then return '__corrupt_next__' end local responseNextOk,responseNext=pcall(cjson.decode,ARGV[17]) local responseFinalOk,responseFinal=pcall(cjson.decode,ARGV[18]) if not responseNextOk or type(responseNext)~='table' or responseNext.ok~=true or not responseFinalOk or type(responseFinal)~='table' or responseFinal.ok~=true then return '__corrupt_next__' end if campaign then local campaignNextOk,campaignNext=pcall(cjson.decode,ARGV[15]) local campaignFinalOk,campaignFinal=pcall(cjson.decode,ARGV[16]) if not campaignNextOk or type(campaignNext)~='table' or tostring(campaignNext.id or '')~=ARGV[7] or not campaignFinalOk or type(campaignFinal)~='table' or tostring(campaignFinal.id or '')~=ARGV[7] then return '__corrupt_next__' end end redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]) redis.call('SADD',KEYS[5],ARGV[8]) redis.call('EXPIRE',KEYS[5],ARGV[4]) if ARGV[5]=='terminal' then redis.call('ZREM',KEYS[2],ARGV[8]) redis.call('SREM',KEYS[3],ARGV[8]) redis.call('DEL',KEYS[4]) elseif ARGV[5]=='schedule' then redis.call('ZADD',KEYS[2],ARGV[6],ARGV[8]) redis.call('SADD',KEYS[3],ARGV[8]) redis.call('EXPIRE',KEYS[3],ARGV[4]) redis.call('DEL',KEYS[4]) else redis.call('ZADD',KEYS[2],ARGV[6],ARGV[8]) redis.call('SADD',KEYS[3],ARGV[8]) redis.call('EXPIRE',KEYS[3],ARGV[4]) end if ARGV[11]=='1' then redis.call('INCR',KEYS[8]) redis.call('EXPIRE',KEYS[8],ARGV[12]) end if campaign then local campaignEncoded=ARGV[15] local responseEncoded=ARGV[17] if ARGV[5]=='terminal' and redis.call('SCARD',KEYS[3])==0 then campaignEncoded=ARGV[16] responseEncoded=ARGV[18] end redis.call('SET',KEYS[6],campaignEncoded,'EX',ARGV[4]) redis.call('ZADD',KEYS[7],'NX',ARGV[13],ARGV[7]) return responseEncoded end return ARGV[17]
`;

async function transitionJob(job, {
  expectedStatuses,
  mode = "keep",
  score = 0,
  dailyKey = "",
  incrementDaily = false,
} = {}) {
  const id = clean(job?.id, 80);
  const campaignId = safeCampaignId(job?.campaignId);
  if (!validJob(job, id, campaignId) || !Array.isArray(expectedStatuses) || !expectedStatuses.length) {
    return { ok: false, error: "invalid_transition" };
  }
  const timestamp = job.updatedAt || new Date().toISOString();
  const jobRaw = JSON.stringify(job);
  const indexScore = String(Date.now());
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const read = await readRedis([["GET", campaignKey(campaignId)], ["PING"]]);
    if (!read.ok || read.rows[1] !== "PONG") return { ok: false, error: "storage_failed" };
    const campaignRaw = read.rows[0];
    const campaign = parseJson(campaignRaw);
    if (campaignRaw != null && !validCampaign(campaign, campaignId)) return { ok: false, error: "storage_failed" };
    const documents = campaignTransitionDocuments(campaignRaw, job, mode, timestamp);
    if (!documents) return { ok: false, error: "storage_failed" };
    let result = await redisCmd([
      "EVAL", TRANSITION_JOB_SCRIPT, "8",
      jobKey(id), QUEUE_KEY, campaignPendingKey(campaignId), claimKey(id),
      campaignJobIndexKey(campaignId), campaignKey(campaignId), CAMPAIGN_INDEX_KEY,
      dailyKey || `${DAILY_COUNT_PREFIX}noop`,
      expectedStatuses.join("|"), jobRaw,
      String(RECORD_TTL_SECONDS), String(CAMPAIGN_TTL_SECONDS), mode,
      String(Number(score || job.queueScore || 0)), campaignId, id, job.status, timestamp,
      incrementDaily ? "1" : "0", String(3 * 24 * 60 * 60), indexScore,
      documents.expectedRaw, documents.campaignNextRaw, documents.campaignFinalRaw,
      documents.responseNext, documents.responseFinal,
    ]);
    if (result == null) {
      const recovery = await readRedis([
        ["GET", jobKey(id)], ["ZSCORE", QUEUE_KEY, id],
        ["SISMEMBER", campaignPendingKey(campaignId), id], ["GET", claimKey(id)],
        ["GET", campaignKey(campaignId)], ["PING"],
      ]);
      const queueOk = mode === "terminal" ? recovery.rows[1] == null
        : Number(recovery.rows[1]) === Number(score || job.queueScore || 0);
      const membershipOk = Number(recovery.rows[2]) === (mode === "terminal" ? 0 : 1);
      const claimOk = (mode !== "terminal" && mode !== "schedule") || recovery.rows[3] == null;
      const campaignStored = recovery.rows[4];
      const campaignOk = campaignRaw == null ? campaignStored == null
        : campaignStored === documents.campaignNextRaw || campaignStored === documents.campaignFinalRaw;
      if (recovery.ok && recovery.rows[0] === jobRaw && queueOk && membershipOk && claimOk
          && campaignOk && recovery.rows[5] === "PONG") {
        result = campaignStored === documents.campaignFinalRaw ? documents.responseFinal : documents.responseNext;
      }
    }
    if (result === "__campaign_conflict__") continue;
    if (String(result || "").startsWith("{")) {
      const parsed = parseJson(result);
      return parsed?.ok ? { ok: true, ...parsed } : { ok: false, error: "storage_failed" };
    }
    if (result === "__missing__") return { ok: false, error: "job_not_found" };
    if (String(result || "").startsWith("__invalid__")) return { ok: false, error: "invalid_job_transition" };
    if (String(result || "").startsWith("__campaign_blocked__")) {
      return { ok: false, error: "campaign_blocked", campaignStatus: String(result).split(":")[1] || "" };
    }
    if (result === "__campaign_missing__") return { ok: false, error: "campaign_not_found" };
    return { ok: false, error: "storage_failed" };
  }
  return { ok: false, error: "storage_conflict" };
}

async function refreshCampaignLifecycle(campaignId) {
  const pending = await redisCmd(["SCARD", campaignPendingKey(campaignId)]);
  if (pending == null || Number(pending) > 0) return false;
  const campaign = await getMarketingCampaign(campaignId);
  if (!campaign || ["completed", "cancelled", "failed"].includes(campaign.status)) return Boolean(campaign);
  const target = Number(campaign.enqueueFailedCount || 0) > 0 ? "failed" : "completed";
  const result = await updateCampaignState(campaignId, target, ["scheduled", "sending", "paused"], {
    [`${target}At`]: new Date().toISOString(),
  });
  return result.ok;
}

async function updateRecipientStatusStrict(job, status, extra = {}) {
  const contactId = job?.contactId || mailContactId(job?.to);
  if (!job?.campaignId || !contactId) return { ok: false, error: "invalid_recipient" };
  const key = recipientKey(job.campaignId, contactId);
  const existingRead = await readRedis([["GET", key], ["PING"]]);
  if (!existingRead.ok || existingRead.rows[1] !== "PONG") return { ok: false, error: "storage_failed" };
  const existing = existingRead.rows[0] == null ? null : parseJson(existingRead.rows[0]);
  if (existingRead.rows[0] != null && (!plain(existing)
    || (existing.campaignId && existing.campaignId !== job.campaignId)
    || (existing.contactId && existing.contactId !== contactId)
    || (existing.email && normalizeEmail(existing.email) !== normalizeEmail(job.to))
    || (existing.jobId && existing.jobId !== job.id))) {
    return { ok: false, error: "storage_failed" };
  }
  const saved = await readRedis([
    [
      "SET",
      key,
      JSON.stringify({
        ...(existing || {}),
        campaignId: job.campaignId,
        contactId,
        email: job.to,
        jobId: job.id,
        messageId: job.deliveryMessageId,
        status,
        ...extra,
        updatedAt: new Date().toISOString(),
      }),
      "EX",
      String(CAMPAIGN_TTL_SECONDS),
    ],
    ["SADD", recipientIndexKey(job.campaignId), contactId],
    ["EXPIRE", recipientIndexKey(job.campaignId), String(CAMPAIGN_TTL_SECONDS)],
    ["PING"],
  ]);
  return saved.ok
    && saved.rows[0] === "OK"
    && saved.rows[1] != null
    && Number(saved.rows[2]) === 1
    && saved.rows[3] === "PONG"
    ? { ok: true }
    : { ok: false, error: "storage_failed" };
}

async function suppressMarketingJob(job, reason, now, { expectedStatus = "queued" } = {}) {
  const safeReason = ["offer_expired", "invalid_offer_end"].includes(reason)
    ? reason
    : clean(reason || "recipient_suppressed", 200);
  const timestamp = new Date(now).toISOString();
  let sourceJob = job;

  // Once a job entered `sending`, persist why the provider call was blocked
  // before touching auxiliary metrics. A retry can then finish suppression
  // instead of treating the deliberately absent delivery as an unknown send.
  if (expectedStatus === "sending" && job.sendBlockedReason !== safeReason) {
    sourceJob = {
      ...job,
      status: "sending",
      sendBlockedReason: safeReason,
      sendBlockedAt: timestamp,
      updatedAt: timestamp,
    };
    const marked = await transitionJob(sourceJob, {
      expectedStatuses: ["sending"],
      mode: "keep",
    });
    if (!marked.ok) return { ok: false, error: "suppression_marker_pending" };
  }

  const metric = await recordMarketingCampaignMetric(sourceJob.campaignId, "suppressed", `dispatch:${sourceJob.id}`);
  if (!metric.ok) return { ok: false, error: "metric_commit_pending" };

  const recipient = await updateRecipientStatusStrict(sourceJob, "suppressed", { reason: safeReason });
  if (!recipient.ok) return { ok: false, error: "recipient_commit_pending" };

  const suppressedJob = {
    ...sourceJob,
    status: "suppressed",
    lastError: safeReason,
    suppressedAt: timestamp,
    updatedAt: timestamp,
  };
  const stored = await transitionJob(suppressedJob, {
    expectedStatuses: [expectedStatus],
    mode: "terminal",
  });
  return stored.ok
    ? { ok: true, job: suppressedJob }
    : { ok: false, error: "delivery_commit_pending" };
}

export async function enqueueMarketingCampaign({
  campaignId,
  recipients,
  scheduledAt,
  subject,
  html,
  text,
  preview,
  brandName,
  support,
  actor,
  name = "",
  templateId = "service_selection_edm_v6",
  templateVersion = 6,
  locale = "zh",
  segmentDefinition = null,
  audienceSnapshot = null,
  offerSnapshot = null,
  productSnapshot = null,
} = {}) {
  const id = safeCampaignId(campaignId);
  const schedule = new Date(scheduledAt || "");
  const scheduledMs = schedule.getTime();
  const uniqueRecipients = Array.from(new Set((Array.isArray(recipients) ? recipients : [])
    .map(normalizeEmail)
    .filter(Boolean)));
  if (!id || !Number.isFinite(scheduledMs) || !uniqueRecipients.length) {
    return { ok: false, error: "invalid_campaign", queuedCount: 0, failedCount: uniqueRecipients.length };
  }

  const scheduledIso = schedule.toISOString();
  const campaignBase = {
    id,
    name: clean(name || subject, 120),
    status: "scheduled",
    templateId: clean(templateId, 80) || "service_selection_edm_v6",
    templateVersion: Number(templateVersion || 6),
    locale: locale === "en" ? "en" : "zh",
    subject: clean(subject, 180),
    html: String(html || "").slice(0, 120000),
    text: String(text || "").slice(0, 12000),
    preview: clean(preview, 240),
    brandName: clean(brandName, 80),
    support: support && typeof support === "object" ? support : {},
    segmentDefinition: segmentDefinition && typeof segmentDefinition === "object" ? segmentDefinition : null,
    audienceSnapshot: audienceSnapshot && typeof audienceSnapshot === "object" ? audienceSnapshot : null,
    offerSnapshot: offerSnapshot && typeof offerSnapshot === "object" ? offerSnapshot : null,
    productSnapshot: Array.isArray(productSnapshot) ? productSnapshot.slice(0, 12) : null,
    scheduledAt: scheduledIso,
    staffId: Number(actor?.staffId || 1),
    staffUsername: clean(actor?.staffUsername || "admin", 60),
  };
  const createdAtMs = Date.now();
  const requestHash = requestFingerprint({
    ...campaignBase,
    status: undefined,
    audienceSnapshot: campaignBase.audienceSnapshot ? { ...campaignBase.audienceSnapshot, generatedAt: undefined } : null,
    recipients: [...uniqueRecipients].sort(),
  });
  const campaign = {
    ...campaignBase,
    requestHash,
    createdAtMs,
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(createdAtMs).toISOString(),
  };
  const campaignCreation = await createCampaign(campaign);
  if (!campaignCreation.ok) {
    return { ok: false, error: campaignCreation.error, queuedCount: 0, failedCount: uniqueRecipients.length };
  }
  const storedCampaignRead = await readRedis([["GET", campaignKey(id)]]);
  if (!storedCampaignRead.ok) {
    return { ok: false, error: "storage_failed", queuedCount: 0, failedCount: uniqueRecipients.length };
  }
  let storedCampaign = parseJson(storedCampaignRead.rows[0]);
  if (!validCampaign(storedCampaign, id)) {
    return { ok: false, error: "storage_failed", queuedCount: 0, failedCount: uniqueRecipients.length };
  }
  if (campaignCreation.duplicate && storedCampaign.status === "failed" && Number(storedCampaign.enqueueFailedCount || 0) > 0) {
    const reopened = await updateCampaignState(id, "scheduled", ["failed"], {
      enqueueFailedCount: 0,
      retryStartedAt: new Date().toISOString(),
    });
    if (!reopened.ok) return { ok: false, error: reopened.error, queuedCount: 0, failedCount: uniqueRecipients.length };
    storedCampaign = reopened.campaign;
  }
  const mayCreateMissingJobs = ["scheduled", "sending"].includes(storedCampaign.status);

  const results = await mapWithConcurrency(uniqueRecipients, ENQUEUE_CONCURRENCY, async (to) => {
    const idempotencyId = makeJobId(id, to, scheduledIso);
    const existingRead = await readRedis([["GET", jobKey(idempotencyId)]]);
    if (!existingRead.ok) return { to, ok: false, retryable: true, reason: "storage_failed" };
    const existing = parseJson(existingRead.rows[0]);
    if (existingRead.rows[0] != null && !validJob(existing, idempotencyId, id, to, scheduledIso)) {
      return { to, ok: false, retryable: true, reason: "storage_failed" };
    }
    if (existing) {
      if (["queued", "sending"].includes(existing.status)) {
        const repaired = await saveJob(existing, Number(existing.queueScore || scheduledMs));
        if (!repaired.ok) return { to, ok: false, retryable: true, reason: "storage_failed", messageId: existing.deliveryMessageId || deliveryMessageId(idempotencyId) };
      }
      const recipientRepaired = await updateRecipientStatusStrict(existing, existing.status || "queued", {
        scheduledAt: existing.scheduledAt || scheduledIso,
      });
      if (!recipientRepaired.ok) {
        return { to, ok: false, retryable: true, reason: "storage_failed", messageId: existing.deliveryMessageId || deliveryMessageId(idempotencyId) };
      }
      if (existing.status === "suppressed") {
        const metric = await recordMarketingCampaignMetric(id, "suppressed", `enqueue:${idempotencyId}`);
        if (!metric.ok) return { to, ok: false, retryable: true, reason: "storage_failed", messageId: existing.deliveryMessageId || deliveryMessageId(idempotencyId) };
        return { to, ok: false, duplicate: true, suppressed: true, status: "suppressed", reason: existing.lastError || "recipient_suppressed", messageId: existing.deliveryMessageId || deliveryMessageId(idempotencyId) };
      }
      if (["failed", "cancelled"].includes(existing.status)) {
        const metric = await recordMarketingCampaignMetric(id, "queued", `enqueue:${idempotencyId}`);
        if (!metric.ok) return { to, ok: false, retryable: true, reason: "storage_failed", messageId: existing.deliveryMessageId || deliveryMessageId(idempotencyId) };
        return { to, ok: false, duplicate: true, terminal: true, status: existing.status, reason: existing.lastError || `job_${existing.status}`, messageId: existing.deliveryMessageId || deliveryMessageId(idempotencyId) };
      }
      const metric = await recordMarketingCampaignMetric(id, "queued", `enqueue:${idempotencyId}`);
      if (!metric.ok) return { to, ok: false, retryable: true, reason: "storage_failed", messageId: existing.deliveryMessageId || deliveryMessageId(idempotencyId) };
      return {
        to,
        ok: true,
        duplicate: true,
        status: existing.status,
        messageId: existing.deliveryMessageId || deliveryMessageId(idempotencyId),
      };
    }
    if (!mayCreateMissingJobs) {
      return { to, ok: false, duplicate: true, terminal: true, status: storedCampaign.status, reason: `campaign_${storedCampaign.status}` };
    }

    const contact = await ensureMailContact(to, { source: "campaign", locale: campaign.locale });
    const decision = await getMailSendDecision({ email: to, purpose: "marketing", category: "marketing", marketing: true });
    if (!decision.allowed) {
      if (decision.retryable || decision.policyUnavailable) {
        return {
          to,
          ok: false,
          retryable: true,
          policyUnavailable: Boolean(decision.policyUnavailable),
          reason: decision.policyUnavailable ? "policy_unavailable" : (decision.reason || "policy_unavailable"),
        };
      }
      const messageId = deliveryMessageId(idempotencyId);
      const suppressedJob = {
        id: idempotencyId,
        campaignId: id,
        contactId: contact?.contactId || mailContactId(to),
        to,
        scheduledAt: scheduledIso,
        status: "queued",
        attempts: 0,
        queueScore: scheduledMs,
        deliveryMessageId: messageId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const savedSuppressedJob = await saveJob(suppressedJob, scheduledMs);
      if (!savedSuppressedJob.ok) return { to, ok: false, retryable: true, reason: "storage_failed", messageId };
      const terminalSuppressedJob = {
        ...suppressedJob,
        status: "suppressed",
        lastError: decision.reason || "recipient_suppressed",
        suppressedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const suppressedTransition = await transitionJob(terminalSuppressedJob, {
        expectedStatuses: ["queued"],
        mode: "terminal",
      });
      if (!suppressedTransition.ok) return { to, ok: false, retryable: true, reason: "storage_failed", messageId };
      await registerEmailDelivery({
        args: {
          to,
          subject: campaign.subject,
          category: "marketing",
          marketing: true,
          relatedType: "scheduled_campaign",
          relatedId: id,
          scheduledAt: scheduledIso,
        },
        result: {
          ok: false,
          suppressed: true,
          status: "suppressed",
          provider: "policy",
          reason: decision.reason || "recipient_suppressed",
          messageId,
          scheduledAt: scheduledIso,
        },
      });
      if (terminalSuppressedJob.contactId) {
        const recipientSaved = await updateRecipientStatusStrict(terminalSuppressedJob, "suppressed", {
          reason: decision.reason || "recipient_suppressed",
          scheduledAt: scheduledIso,
        });
        if (!recipientSaved.ok) return { to, ok: false, retryable: true, reason: "storage_failed", messageId };
      }
      const metric = await recordMarketingCampaignMetric(id, "suppressed", `enqueue:${idempotencyId}`);
      if (!metric.ok) return { to, ok: false, retryable: true, reason: "storage_failed", messageId };
      return { to, ok: false, suppressed: true, reason: decision.reason, messageId };
    }

    const job = {
      id: idempotencyId,
      campaignId: id,
      contactId: contact?.contactId || mailContactId(to),
      to,
      scheduledAt: scheduledIso,
      status: "queued",
      attempts: Number(existing?.attempts || 0),
      queueScore: scheduledMs,
      deliveryMessageId: deliveryMessageId(idempotencyId),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const saved = await saveJob(job, scheduledMs);
    if (!saved.ok) {
      return { to, ok: false, reason: "storage_failed", messageId: job.deliveryMessageId };
    }
    await registerEmailDelivery({
      args: {
        to,
        subject: campaign.subject,
        category: "marketing",
        marketing: true,
        relatedType: "scheduled_campaign",
        relatedId: id,
        scheduledAt: scheduledIso,
      },
      result: {
        ok: true,
        scheduled: true,
        provider: "queue",
        messageId: job.deliveryMessageId,
        scheduledAt: scheduledIso,
      },
    });
    if (job.contactId) {
      const recipientSaved = await updateRecipientStatusStrict(job, "queued", { scheduledAt: scheduledIso });
      if (!recipientSaved.ok) {
        return { to, ok: false, retryable: true, reason: "storage_failed", messageId: job.deliveryMessageId };
      }
    }
    const metric = await recordMarketingCampaignMetric(id, "queued", `enqueue:${idempotencyId}`);
    if (!metric.ok) return { to, ok: false, retryable: true, reason: "storage_failed", messageId: job.deliveryMessageId };
    return { to, ok: true, duplicate: !saved.created, status: "queued", messageId: job.deliveryMessageId };
  });

  const queuedCount = results.filter((item) => item.ok && ["queued", "sending"].includes(item.status)).length;
  const acceptedCount = results.filter((item) => item.ok).length;
  const suppressedCount = results.filter((item) => item.suppressed).length;
  const failedCount = results.filter((item) => !item.ok && !item.suppressed).length;
  const latestRead = await readRedis([["GET", campaignKey(id)]]);
  if (!latestRead.ok) {
    return { ok: false, error: "storage_failed", campaignId: id, scheduledAt: scheduledIso, queuedCount, suppressedCount, failedCount, results: results.map(({ to: _recipient, ...item }) => item) };
  }
  const latestCampaign = parseJson(latestRead.rows[0]);
  if (!validCampaign(latestCampaign, id)) {
    return { ok: false, error: "storage_failed", campaignId: id, scheduledAt: scheduledIso, queuedCount, suppressedCount, failedCount, results: [] };
  }
  const summaryStatus = ["scheduled", "sending"].includes(latestCampaign?.status) ? latestCampaign.status : "";
  const summary = summaryStatus ? await updateCampaignState(id, summaryStatus, [summaryStatus], {
    recipientCount: uniqueRecipients.length,
    queuedCount,
    acceptedCount,
    suppressedCount,
    enqueueFailedCount: failedCount,
    enqueueCompletedAt: new Date().toISOString(),
  }) : { ok: true };
  if (!summary.ok) {
    return { ok: false, error: "storage_failed", campaignId: id, scheduledAt: scheduledIso, queuedCount, suppressedCount, failedCount, results: results.map(({ to: _recipient, ...item }) => item) };
  }
  await refreshCampaignLifecycle(id);
  const safeResults = results.map(({ to: _recipient, ...item }) => item);
  return {
    ok: failedCount === 0,
    campaignId: id,
    scheduledAt: scheduledIso,
    queuedCount,
    suppressedCount,
    failedCount,
    results: safeResults,
  };
}

async function recordDispatch(job, campaign, result) {
  const reason = result?.ok === true ? "" : clean(result?.reason || result?.error || result?.code || "send_failed", 200);
  const outcomeClass = providerOutcomeClass(result);
  const delivery = await registerEmailDelivery({
    args: {
      to: job.to,
      subject: campaign.subject,
      category: "marketing",
      marketing: true,
      relatedType: "scheduled_campaign",
      relatedId: job.campaignId,
      scheduledAt: job.scheduledAt,
    },
    result: {
      ...result,
      messageId: job.deliveryMessageId,
      providerMessageId: result?.messageId || "",
      scheduledAt: job.scheduledAt,
      status: result?.suppressed ? "suppressed" : (result?.ok === true ? "sent" : "failed"),
      providerOutcomeClass: outcomeClass,
      providerErrorCode: clean(result?.errorCode || "", 80),
      providerUncertain: outcomeClass === "uncertain",
      forceStatus: true,
    },
  });
  await pushAdminMailLog({
    to: job.to,
    subject: campaign.subject,
    content: campaign.preview,
    preview: campaign.preview,
    ok: result?.ok === true,
    reason,
    messageId: result?.messageId || job.deliveryMessageId,
    category: "marketing",
    relatedType: "scheduled_campaign",
    relatedId: job.campaignId,
    campaignId: job.campaignId,
    template: campaign.templateId || "service_selection_edm_v6",
    staffId: campaign.staffId,
    staffUsername: campaign.staffUsername,
  });
  return { ok: Boolean(delivery), delivery };
}

const RENEW_DISPATCH_LEASE_SCRIPT = `
if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) end return 0
`;

const RELEASE_DISPATCH_LEASE_SCRIPT = `
if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0
`;

const VERIFY_SEND_OWNERSHIP_SCRIPT = `
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end local jobRaw=redis.call('GET',KEYS[3]) local campaignRaw=redis.call('GET',KEYS[4]) if not jobRaw or not campaignRaw then return 0 end local jobOk,job=pcall(cjson.decode,jobRaw) local campaignOk,campaign=pcall(cjson.decode,campaignRaw) if not jobOk or not campaignOk then return 0 end if tostring(job.id or '')~=ARGV[2] or tostring(job.campaignId or '')~=ARGV[3] or tostring(campaign.id or '')~=ARGV[3] then return 0 end if tostring(job.status or '')~='sending' then return 0 end if tostring(campaign.status or '')~='sending' then return 0 end return 1
`;

async function renewDispatchLease(token, ttlSeconds) {
  return Number(await redisCmd(["EVAL", RENEW_DISPATCH_LEASE_SCRIPT, "1", DISPATCH_LOCK_KEY, token, String(ttlSeconds)])) === 1;
}

async function releaseDispatchLease(token) {
  return Number(await redisCmd(["EVAL", RELEASE_DISPATCH_LEASE_SCRIPT, "1", DISPATCH_LOCK_KEY, token])) === 1;
}

async function verifySendOwnership({ lockToken, job }) {
  return Number(await redisCmd([
    "EVAL",
    VERIFY_SEND_OWNERSHIP_SCRIPT,
    "4",
    DISPATCH_LOCK_KEY,
    claimKey(job.id),
    jobKey(job.id),
    campaignKey(job.campaignId),
    lockToken,
    job.id,
    job.campaignId,
  ])) === 1;
}

const RESERVE_DAILY_ATTEMPT_SCRIPT = `
-- MARKETING_DAILY_ATTEMPT_RESERVE_V1
local function validtype(key,expected) local value=redis.call('TYPE',key); local actual=type(value)=='table' and value.ok or value; return actual=='none' or actual==expected end
if not validtype(KEYS[1],'string') or not validtype(KEYS[2],'string') then return '__storage_type__' end
local dailyLimit=tonumber(ARGV[2]); local dailyTtl=tonumber(ARGV[3]); local attemptTtl=tonumber(ARGV[4])
if not dailyLimit or dailyLimit~=math.floor(dailyLimit) or dailyLimit<1 or not dailyTtl or dailyTtl~=math.floor(dailyTtl) or dailyTtl<1 or not attemptTtl or attemptTtl~=math.floor(attemptTtl) or attemptTtl<1 then return '__invalid_args__' end
local existing=redis.call('GET',KEYS[2])
if existing then
  if not string.match(existing,'^%d%d%d%d%d%d%d%d$') then return '__reservation_conflict__' end
  if existing~=ARGV[1] then return '__reserved__:'..existing end
  local duplicateRaw=redis.call('GET',KEYS[1]); local duplicateCount=duplicateRaw and tonumber(duplicateRaw) or nil
  if not duplicateCount or duplicateCount~=math.floor(duplicateCount) or duplicateCount<1 or duplicateCount>dailyLimit then return '__invalid_daily_count__' end
  redis.call('EXPIRE',KEYS[2],ARGV[4])
  return '__reserved__:'..existing
end
local dailyRaw=redis.call('GET',KEYS[1]); local dailyCount=dailyRaw and tonumber(dailyRaw) or 0
if not dailyCount or dailyCount~=math.floor(dailyCount) or dailyCount<0 or dailyCount>dailyLimit then return '__invalid_daily_count__' end
if dailyCount>=dailyLimit then return '__daily_limit__' end
redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[4])
local nextCount=redis.call('INCR',KEYS[1])
redis.call('EXPIRE',KEYS[1],ARGV[3])
return tostring(nextCount)
`;

async function reserveDailyAttempt(attemptKey, logicalNow) {
  const day = beijingDayKey(logicalNow);
  const countKey = DAILY_COUNT_PREFIX + day;
  if (!attemptKey || !/^\d{8}$/.test(day)) return { ok: false, error: "invalid_attempt" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await redisCmd([
      "EVAL", RESERVE_DAILY_ATTEMPT_SCRIPT, "2",
      countKey, attemptKey,
      day, String(DAILY_LIMIT), String(3 * 24 * 60 * 60), String(RECORD_TTL_SECONDS),
    ]);
    if (result === "__daily_limit__") return { ok: false, dailyLimit: true, day, dailyKey: countKey };
    if (String(result || "").startsWith("__reserved__:")) {
      const reservedDay = String(result).slice("__reserved__:".length);
      if (!/^\d{8}$/.test(reservedDay)) return { ok: false, error: "quota_storage_invalid" };
      return {
        ok: true,
        duplicate: true,
        day: reservedDay,
        dailyKey: DAILY_COUNT_PREFIX + reservedDay,
      };
    }
    const count = Number(result);
    if (Number.isSafeInteger(count) && count >= 1 && count <= DAILY_LIMIT) {
      return { ok: true, duplicate: false, count, day, dailyKey: countKey };
    }
    if (result != null) return { ok: false, error: "quota_storage_invalid" };

    // Upstash can commit a Lua script while its HTTP response is lost. Reading the
    // per-attempt marker makes retrying this exact provider attempt idempotent.
    const recovery = await readRedis([["GET", attemptKey]]);
    if (recovery.ok && recovery.rows[0] === day) {
      const countRead = await readRedis([["GET", countKey]]);
      const recoveredCount = Number(countRead.rows[0]);
      if (countRead.ok && Number.isSafeInteger(recoveredCount) && recoveredCount >= 1 && recoveredCount <= DAILY_LIMIT) {
        return { ok: true, duplicate: true, recovered: true, count: recoveredCount, day, dailyKey: countKey };
      }
    }
  }
  return { ok: false, error: "quota_storage_unavailable" };
}

async function reserveDailyProviderAttempt(job, logicalNow) {
  return reserveDailyAttempt(dailyAttemptKey(job), logicalNow);
}

// All Resend marketing paths share this budget. `reservationId` identifies one
// logical provider attempt; replaying the same attempt after a lost Redis
// response does not increment the Beijing-day counter twice.
export async function reserveMarketingSendBudget({ reservationId = "", now = Date.now() } = {}) {
  const stableId = clean(reservationId, 300);
  if (!stableId) return { ok: false, error: "invalid_attempt" };
  const digest = createHash("sha256").update(stableId).digest("hex");
  return reserveDailyAttempt(`${DAILY_ATTEMPT_PREFIX}external:${digest}`, now);
}

export async function dispatchDueMarketingCampaigns({
  now = Date.now(),
  limit = DAILY_LIMIT,
  shouldContinue = () => true,
  deadlineAt = 0,
  lockTtlSeconds = DISPATCH_LOCK_TTL_SECONDS,
  lockHeartbeatMs = DISPATCH_LOCK_HEARTBEAT_MS,
  interJobDelayMs = 550,
  _testHooks = null,
} = {}) {
  const logicalStart = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const wallClockStart = Date.now();
  const logicalNow = () => logicalStart + Math.max(0, Date.now() - wallClockStart);
  const canContinue = () => {
    if (Number(deadlineAt) > 0 && Date.now() >= Number(deadlineAt)) return false;
    try { return typeof shouldContinue !== "function" || shouldContinue() !== false; } catch { return false; }
  };
  const commitDeadlineAt = Number(deadlineAt) > 0
    ? Math.max(0, Number(deadlineAt) - DISPATCH_RETURN_RESERVE_MS)
    : 0;
  const settleUntil = async (factory, cutoffAt = 0) => {
    if (!cutoffAt) {
      try { return { settled: true, value: await factory() }; }
      catch (error) { return { settled: true, error }; }
    }
    const remainingMs = cutoffAt - Date.now();
    if (remainingMs <= 0) return { settled: false };
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ settled: false }), Math.max(1, Math.trunc(remainingMs)));
      Promise.resolve().then(factory).then(
        (value) => { clearTimeout(timer); resolve({ settled: true, value }); },
        (error) => { clearTimeout(timer); resolve({ settled: true, error }); },
      );
    });
  };
  const settleCommit = (factory) => settleUntil(factory, commitDeadlineAt);
  const PRE_PROVIDER_TIMEOUT = Symbol("marketing_pre_provider_timeout");
  const preProvider = async (factory) => {
    const settled = await settleUntil(factory, commitDeadlineAt);
    if (!settled.settled) throw PRE_PROVIDER_TIMEOUT;
    if (settled.error) throw settled.error;
    return settled.value;
  };
  const deadlineResult = ({ submitted = 0, failed = 0, results = [] } = {}) => ({
    ok: false,
    partial: true,
    deadlineExceeded: true,
    error: "maintenance_deadline_exceeded",
    submitted,
    failed,
    results: results.map(({ to: _recipient, ...item }) => item),
  });
  const requeueSendingForStop = async (job, _sendingJob, id) => {
    const originalScore = Number(job?.queueScore || now);
    const resumeScore = Number.isFinite(originalScore) ? originalScore : Date.now();
    const resumed = await transitionJob({
      // `job` is the last queued record. Reusing it preserves an inherited
      // uncertain-provider deadline, but removes the fresh deadline/attempt
      // created by this worker when it definitively stopped before the provider.
      ...job,
      status: "queued",
      queueScore: resumeScore,
      nextAttemptAt: new Date(resumeScore).toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      expectedStatuses: ["sending"], mode: "schedule", score: resumeScore,
    });
    if (!resumed.ok) await redisCmd(["DEL", claimKey(id)]);
    return resumed.ok;
  };
  if (!canContinue()) {
    return {
      ok: false,
      partial: true,
      deadlineExceeded: true,
      error: "maintenance_deadline_exceeded",
      submitted: 0,
      failed: 0,
      results: [],
    };
  }
  const ttlSeconds = Math.max(1, Math.trunc(Number(lockTtlSeconds) || DISPATCH_LOCK_TTL_SECONDS));
  const heartbeatMs = Math.max(25, Math.min(ttlSeconds * 500, Number(lockHeartbeatMs) || DISPATCH_LOCK_HEARTBEAT_MS));
  const lockToken = randomBytes(18).toString("hex");
  let acquired;
  try {
    acquired = await preProvider(() => redisCmd(["SET", DISPATCH_LOCK_KEY, lockToken, "NX", "EX", String(ttlSeconds)]));
  } catch (error) {
    if (error === PRE_PROVIDER_TIMEOUT) return deadlineResult();
    throw error;
  }
  if (acquired !== "OK") {
    // Distinguish a healthy competing lock from a storage outage.
    let lockRead;
    try {
      lockRead = await preProvider(() => readRedis([["GET", DISPATCH_LOCK_KEY]]));
    } catch (error) {
      if (error === PRE_PROVIDER_TIMEOUT) return deadlineResult();
      throw error;
    }
    if (!lockRead.ok || !lockRead.rows[0]) {
      return { ok: false, skipped: true, reason: "lock_store_unavailable", submitted: 0, failed: 0 };
    }
    if (lockRead.rows[0] !== lockToken) return { ok: true, skipped: true, reason: "locked", submitted: 0, failed: 0 };
  }

  let submitted = 0;
  let failed = 0;
  let providerAttempts = 0;
  let removedInvalidQueueMembers = 0;
  let removedInvalidJobs = 0;
  const results = [];
  let leaseLost = false;
  let deadlineExceeded = false;
  let renewalInFlight = false;
  const commitProviderState = async (factory, id, to = "") => {
    const committed = await settleCommit(factory);
    if (!committed.settled) {
      deadlineExceeded = true;
      results.push({ id, to, ok: true, skipped: true, retryable: true, reason: "provider_outcome_commit_deferred" });
      return { deferred: true };
    }
    if (committed.error) throw committed.error;
    return { deferred: false, value: committed.value };
  };
  const heartbeat = setInterval(() => {
    if (renewalInFlight || leaseLost) return;
    renewalInFlight = true;
    renewDispatchLease(lockToken, ttlSeconds)
      .then((renewed) => { if (!renewed) leaseLost = true; })
      .catch(() => { leaseLost = true; })
      .finally(() => { renewalInFlight = false; });
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    const initialDayKey = DAILY_COUNT_PREFIX + beijingDayKey(logicalNow());
    const dailyRead = await preProvider(() => readRedis([["GET", initialDayKey]]));
    if (!dailyRead.ok) return { ok: false, reason: "storage_unavailable", submitted: 0, failed: 0 };
    const alreadyReserved = Number(dailyRead.rows[0] || 0);
    if (!Number.isSafeInteger(alreadyReserved) || alreadyReserved < 0 || alreadyReserved > DAILY_LIMIT) {
      return { ok: false, reason: "storage_unavailable", submitted: 0, failed: 0 };
    }
    const requestedLimit = Number(limit);
    const perRunLimit = Number.isFinite(requestedLimit)
      ? Math.max(0, Math.min(DAILY_LIMIT, Math.trunc(requestedLimit)))
      : DAILY_LIMIT;
    const capacity = Math.max(0, Math.min(perRunLimit, DAILY_LIMIT - alreadyReserved));
    if (!capacity) return { ok: true, skipped: true, reason: "daily_limit", submitted: 0, failed: 0 };

    const dueIds = await preProvider(() => redisCmd([
      "ZRANGEBYSCORE",
      QUEUE_KEY,
      "-inf",
      String(now),
    ]));
    if (!Array.isArray(dueIds)) {
      return { ok: false, reason: "storage_unavailable", submitted: 0, failed: 0 };
    }
    if (!dueIds.length) {
      return { ok: true, skipped: true, reason: "nothing_due", submitted: 0, failed: 0 };
    }

    for (const rawJobId of dueIds) {
      if (providerAttempts >= capacity) break;
      if (!canContinue()) {
        deadlineExceeded = true;
        break;
      }
      if (leaseLost || !(await preProvider(() => renewDispatchLease(lockToken, ttlSeconds)))) {
        leaseLost = true;
        break;
      }
      const rawId = typeof rawJobId === "string" ? rawJobId : String(rawJobId ?? "");
      const id = clean(rawId, 80);
      if (!rawId || !id || id !== rawId) {
        const cleanup = await preProvider(() => readRedis([["ZREM", QUEUE_KEY, rawId]]));
        if (!cleanup.ok) {
          failed += 1;
          results.push({ id: "", ok: false, retryable: true, reason: "queue_cleanup_unavailable" });
          break;
        }
        failed += 1;
        results.push({ id: "", ok: false, retryable: false, reason: "invalid_job_id" });
        removedInvalidQueueMembers += 1;
        continue;
      }
      const claimed = await preProvider(() => redisCmd(["SET", claimKey(id), lockToken, "NX", "EX", "180"]));
      if (claimed !== "OK") {
        const claimRead = await preProvider(() => readRedis([["GET", claimKey(id)]]));
        if (!claimRead.ok) { failed += 1; results.push({ id, ok: false, retryable: true, reason: "claim_store_unavailable" }); break; }
        if (claimRead.rows[0] !== lockToken) continue;
      }
      if (!canContinue()) {
        deadlineExceeded = true;
        await preProvider(() => redisCmd(["DEL", claimKey(id)]));
        break;
      }
      if (typeof _testHooks?.afterClaim === "function") {
        await _testHooks.afterClaim({ campaignJobId: id });
      }

      const jobRead = await preProvider(() => readRedis([["GET", jobKey(id)]]));
      if (!jobRead.ok) {
        await preProvider(() => redisCmd(["DEL", claimKey(id)]));
        failed += 1;
        results.push({ id, ok: false, retryable: true, reason: "storage_unavailable" });
        break;
      }
      const job = parseJson(jobRead.rows[0]);
      if (!validJob(job, id)) {
        const cleanup = await preProvider(() => readRedis([["ZREM", QUEUE_KEY, rawId], ["DEL", claimKey(id)]]));
        if (!cleanup.ok) {
          failed += 1;
          results.push({ id, ok: false, retryable: true, reason: "queue_cleanup_unavailable" });
          break;
        }
        failed += 1;
        results.push({ id, ok: false, retryable: false, reason: "invalid_job_record" });
        removedInvalidJobs += 1;
        continue;
      }
      if (["submitted", "suppressed", "failed", "cancelled"].includes(job.status)) {
        await preProvider(() => redisPipeline([["ZREM", QUEUE_KEY, id], ["DEL", claimKey(id)], ...(job?.campaignId ? [["SREM", campaignPendingKey(job.campaignId), id]] : [])]));
        if (job?.campaignId) await preProvider(() => refreshCampaignLifecycle(job.campaignId));
        continue;
      }
      if (job.status === "sending") {
        if (["offer_expired", "invalid_offer_end"].includes(job.sendBlockedReason)) {
          const suppression = await preProvider(() => suppressMarketingJob(job, job.sendBlockedReason, now, { expectedStatus: "sending" }));
          if (!suppression.ok) {
            await preProvider(() => redisCmd(["DEL", claimKey(id)]));
            failed += 1;
            results.push({ id, to: job.to, ok: false, retryable: true, reason: suppression.error });
          } else {
            results.push({ id, to: job.to, ok: false, suppressed: true, reason: job.sendBlockedReason });
          }
          continue;
        }
        // Read an existing durable provider outcome before touching today's
        // quota. Terminal/known failures need no new provider call and must not
        // consume one of the 50 slots for the current Beijing day.
        const deliveryRead = await preProvider(() => readEmailDeliveryByMessageId(job.deliveryMessageId));
        if (!deliveryRead.ok) {
          await preProvider(() => redisCmd(["DEL", claimKey(id)]));
          failed += 1;
          results.push({ id, to: job.to, ok: false, retryable: true, reason: "delivery_recovery_unavailable" });
          continue;
        }
        const delivery = deliveryRead.record;
        const deliveryMatches = Boolean(delivery
          && delivery.category === "marketing"
          && delivery.relatedType === "scheduled_campaign"
          && delivery.relatedId === job.campaignId
          && normalizeRecipients(delivery.recipients?.length ? delivery.recipients : delivery.to).includes(normalizeEmail(job.to)));
        const trustedDelivery = deliveryMatches ? delivery : null;
        if (trustedDelivery && ["sent", "delivered", "recovered"].includes(trustedDelivery.status)) {
          const recoveredJob = {
            ...job,
            status: "submitted",
            provider: clean(trustedDelivery.provider || "resend", 30),
            providerMessageId: clean(trustedDelivery.providerMessageId, 180),
            submittedAt: trustedDelivery.updatedAt || new Date(now).toISOString(),
            recoveredAt: new Date(now).toISOString(),
            lastError: "",
            updatedAt: new Date(now).toISOString(),
          };
          const recoveredMetric = await preProvider(() => recordMarketingCampaignMetric(job.campaignId, "submitted", `dispatch:${id}`));
          if (!recoveredMetric.ok) {
            await preProvider(() => redisCmd(["DEL", claimKey(id)]));
            failed += 1;
            results.push({ id, to: job.to, ok: false, retryable: true, reason: "metric_commit_pending" });
            continue;
          }
          const recovered = await preProvider(() => transitionJob(recoveredJob, {
            expectedStatuses: ["sending"],
            mode: "terminal",
          }));
          if (!recovered.ok) {
            await preProvider(() => redisCmd(["DEL", claimKey(id)]));
            failed += 1;
            results.push({ id, to: job.to, ok: false, retryable: true, reason: "delivery_commit_pending" });
            continue;
          }
          await preProvider(() => updateRecipientStatusStrict(job, "submitted", { provider: recoveredJob.provider, providerMessageId: recoveredJob.providerMessageId, submittedAt: recoveredJob.submittedAt }));
          submitted += 1;
          results.push({ id, to: job.to, ok: true, recovered: true, messageId: recoveredJob.providerMessageId });
          continue;
        }
        if (trustedDelivery?.status === "suppressed") {
          const suppressedJob = {
            ...job,
            status: "suppressed",
            lastError: clean(trustedDelivery.reason || "recipient_suppressed", 200),
            suppressedAt: trustedDelivery.updatedAt || new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          };
          const metric = await preProvider(() => recordMarketingCampaignMetric(job.campaignId, "suppressed", `dispatch:${id}`));
          const recovered = metric.ok ? await preProvider(() => transitionJob(suppressedJob, {
            expectedStatuses: ["sending"],
            mode: "terminal",
          })) : { ok: false };
          if (!recovered.ok) {
            await preProvider(() => redisCmd(["DEL", claimKey(id)]));
            failed += 1;
            results.push({ id, to: job.to, ok: false, retryable: true, reason: metric.ok ? "delivery_commit_pending" : "metric_commit_pending" });
          } else {
            await preProvider(() => updateRecipientStatusStrict(job, "suppressed", { reason: suppressedJob.lastError }));
            results.push({ id, to: job.to, ok: true, suppressed: true, recovered: true, reason: suppressedJob.lastError });
          }
          continue;
        }

        const recoveryDeadlineMs = Date.parse(job.resendIdempotencyDeadlineAt || "");
        const providerStartedMs = Date.parse(job.providerAttemptStartedAt || "");
        const recoveryNow = logicalNow();
        const outcomeClass = clean(trustedDelivery?.providerOutcomeClass || "", 40);
        const outcomeReason = clean(trustedDelivery?.reason || outcomeClass || "provider_failed", 200);

        if (trustedDelivery?.status === "failed"
            && ["quota", "policy_retry", "definite_failure", "idempotency_conflict"].includes(outcomeClass)) {
          const quotaFailure = outcomeClass === "quota";
          const policyRetry = outcomeClass === "policy_retry";
          const idempotencyConflict = outcomeClass === "idempotency_conflict";
          const failedAttempts = Number(job.failedAttempts || 0) + (quotaFailure || policyRetry ? 0 : 1);
          const retryBase = withoutProviderAttemptState(job);
          if (idempotencyConflict || (!quotaFailure && !policyRetry && failedAttempts >= MAX_SEND_ATTEMPTS)) {
            const deadJob = {
              ...retryBase,
              status: "failed",
              failedAttempts,
              lastError: idempotencyConflict ? "idempotency_payload_conflict" : outcomeReason,
              failedAt: new Date(recoveryNow).toISOString(),
              updatedAt: new Date(recoveryNow).toISOString(),
            };
            const metric = await preProvider(() => recordMarketingCampaignMetric(job.campaignId, "failed", `dispatch:${id}`));
            const stored = metric.ok ? await preProvider(() => transitionJob(deadJob, { expectedStatuses: ["sending"], mode: "terminal" })) : { ok: false };
            if (stored.ok) await preProvider(() => updateRecipientStatusStrict(job, "failed", { reason: deadJob.lastError }));
            else await preProvider(() => redisCmd(["DEL", claimKey(id)]));
            failed += 1;
            results.push({ id, to: job.to, ok: false, permanent: stored.ok, reason: stored.ok ? deadJob.lastError : "delivery_commit_pending" });
          } else {
            const nextAttemptMs = quotaFailure ? nextBeijingEvening(recoveryNow) : recoveryNow + RETRY_DELAY_MS;
            const retryJob = {
              ...retryBase,
              status: "queued",
              queueScore: nextAttemptMs,
              failedAttempts,
              lastError: outcomeReason,
              nextAttemptAt: new Date(nextAttemptMs).toISOString(),
              updatedAt: new Date(recoveryNow).toISOString(),
            };
            const stored = await preProvider(() => transitionJob(retryJob, { expectedStatuses: ["sending"], mode: "schedule", score: nextAttemptMs }));
            if (!stored.ok) failed += 1;
            results.push({ id, to: job.to, ok: false, retryable: true, reason: stored.ok ? outcomeReason : "delivery_commit_pending" });
          }
          continue;
        }

        if (Number(job.providerProtocolVersion) === 2
            && !Number.isFinite(providerStartedMs)
            && (!trustedDelivery || trustedDelivery.status === "scheduled")) {
          // This worker persisted `sending` but never persisted the marker that
          // immediately precedes the provider call. It is therefore known that
          // no Resend request started; restore the original attempt without an
          // uncertainty deadline or a fresh quota charge.
          const originalScore = Number(job.resumeQueueScore ?? job.queueScore);
          const resumeScore = Number.isFinite(originalScore) ? Math.min(originalScore, recoveryNow) : recoveryNow;
          const retryJob = {
            ...withoutProviderAttemptState(job),
            status: "queued",
            attempts: Math.max(0, Number(job.attempts || 1) - 1),
            queueScore: resumeScore,
            nextAttemptAt: new Date(recoveryNow).toISOString(),
            updatedAt: new Date(recoveryNow).toISOString(),
          };
          const recovered = await preProvider(() => transitionJob(retryJob, { expectedStatuses: ["sending"], mode: "schedule", score: resumeScore }));
          if (!recovered.ok) failed += 1;
          results.push({ id, to: job.to, ok: recovered.ok, skipped: recovered.ok, retryable: true, reason: recovered.ok ? "provider_not_started_requeued" : "delivery_commit_pending" });
          continue;
        }

        if ((!trustedDelivery || trustedDelivery.status === "scheduled" || outcomeClass === "uncertain")
            && Number.isFinite(providerStartedMs)
            && Number.isFinite(recoveryDeadlineMs) && recoveryNow < recoveryDeadlineMs) {
          const attemptMarker = dailyAttemptKey(job);
          const markerRead = attemptMarker ? await preProvider(() => readRedis([["GET", attemptMarker]])) : { ok: false, rows: [] };
          if (!markerRead.ok) {
            await preProvider(() => redisCmd(["DEL", claimKey(id)]));
            failed += 1;
            results.push({ id, to: job.to, ok: false, retryable: true, reason: "quota_storage_unavailable" });
            continue;
          }
          if (/^\d{8}$/.test(String(markerRead.rows[0] || ""))) {
          // The process may have stopped immediately before or after the Resend
          // request. Requeue a new locally-counted attempt while retaining the
          // same provider idempotency key (job.id). This can waste quota but can
          // neither exceed today's 50-attempt ceiling nor duplicate the email.
          const recoveryScore = ambiguousRecoveryScore(recoveryDeadlineMs);
          const retryJob = {
            ...job,
            status: "queued",
            // All ambiguous retries sort ahead of ordinary campaigns, ordered
            // by the earliest provider-idempotency deadline first.
            queueScore: recoveryScore,
            nextAttemptAt: new Date(recoveryNow).toISOString(),
            updatedAt: new Date(recoveryNow).toISOString(),
          };
          const recovered = await preProvider(() => transitionJob(retryJob, {
            expectedStatuses: ["sending"], mode: "schedule", score: recoveryScore,
          }));
          if (!recovered.ok) {
            failed += 1;
            results.push({ id, to: job.to, ok: false, retryable: true, reason: "delivery_commit_pending" });
          } else {
            results.push({ id, to: job.to, ok: true, skipped: true, retryable: true, reason: "idempotent_provider_retry_scheduled" });
          }
          continue;
          }
        }
        const unknownJob = {
          ...job,
          status: "failed",
          lastError: "delivery_outcome_unknown",
          failedAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        };
        const unknownMetric = await preProvider(() => recordMarketingCampaignMetric(job.campaignId, "failed", `dispatch:${id}:unknown`));
        if (!unknownMetric.ok) {
          await preProvider(() => redisCmd(["DEL", claimKey(id)]));
          failed += 1;
          results.push({ id, to: job.to, ok: false, retryable: true, reason: "metric_commit_pending" });
          continue;
        }
        const quarantined = await preProvider(() => transitionJob(unknownJob, { expectedStatuses: ["sending"], mode: "terminal" }));
        if (quarantined.ok) {
          await preProvider(() => updateRecipientStatusStrict(job, "failed", { reason: unknownJob.lastError }));
        }
        failed += 1;
        results.push({ id, to: job.to, ok: false, permanent: quarantined.ok, reason: quarantined.ok ? "delivery_outcome_unknown" : "delivery_commit_pending" });
        continue;
      }
      const campaignRead = await preProvider(() => readRedis([["GET", campaignKey(job.campaignId)]]));
      if (!campaignRead.ok) {
        await preProvider(() => redisCmd(["DEL", claimKey(id)]));
        failed += 1;
        results.push({ id, to: job.to, ok: false, retryable: true, reason: "storage_unavailable" });
        break;
      }
      const campaign = parseJson(campaignRead.rows[0]);
      if (campaignRead.rows[0] != null && !validCampaign(campaign, job.campaignId)) {
        await preProvider(() => redisCmd(["DEL", claimKey(id)]));
        failed += 1;
        results.push({ id, to: job.to, ok: false, retryable: false, reason: "invalid_campaign_record" });
        continue;
      }
      if (!campaign) {
        const failedJob = { ...job, status: "failed", lastError: "campaign_missing", updatedAt: new Date(now).toISOString() };
        const stored = await preProvider(() => transitionJob(failedJob, { expectedStatuses: ["queued"], mode: "terminal" }));
        failed += 1;
        results.push({ id, to: job.to, ok: false, reason: stored.ok ? "campaign_missing" : "storage_failed" });
        continue;
      }
      if (campaign.status === "paused") {
        const nextAttemptMs = now + 15 * 60 * 1000;
        await preProvider(() => transitionJob({ ...job, status: "queued", queueScore: nextAttemptMs, nextAttemptAt: new Date(nextAttemptMs).toISOString(), updatedAt: new Date(now).toISOString() }, {
          expectedStatuses: ["queued"], mode: "schedule", score: nextAttemptMs,
        }));
        results.push({ id, to: job.to, ok: true, skipped: true, reason: "campaign_paused" });
        continue;
      }
      if (campaign.status === "cancelled") {
        await preProvider(() => transitionJob({ ...job, status: "cancelled", cancelledAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }, {
          expectedStatuses: ["queued"], mode: "terminal",
        }));
        await preProvider(() => updateRecipientStatusStrict(job, "cancelled"));
        await preProvider(() => refreshCampaignLifecycle(job.campaignId));
        results.push({ id, to: job.to, ok: true, skipped: true, reason: "campaign_cancelled" });
        continue;
      }
      if (!["scheduled", "sending"].includes(campaign.status)) {
        const inactiveJob = {
          ...job,
          status: "failed",
          lastError: `campaign_${clean(campaign.status, 30) || "inactive"}`,
          failedAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        };
        await preProvider(() => transitionJob(inactiveJob, { expectedStatuses: ["queued"], mode: "terminal" }));
        failed += 1;
        results.push({ id, to: job.to, ok: false, permanent: true, reason: inactiveJob.lastError });
        continue;
      }
      if (typeof campaign.subject !== "string" || typeof campaign.html !== "string") {
        await preProvider(() => redisCmd(["DEL", claimKey(id)]));
        failed += 1;
        results.push({ id, to: job.to, ok: false, retryable: false, reason: "invalid_campaign_record" });
        continue;
      }

      const offerBlockReason = offerDispatchBlockReason(
        campaign.offerSnapshot,
        Math.max(Number(now) || 0, Date.now()),
      );
      if (offerBlockReason) {
        const suppression = await preProvider(() => suppressMarketingJob(job, offerBlockReason, now, { expectedStatus: "queued" }));
        if (!suppression.ok) {
          await preProvider(() => redisCmd(["DEL", claimKey(id)]));
          failed += 1;
          results.push({ id, to: job.to, ok: false, retryable: true, reason: suppression.error });
        } else {
          results.push({ id, to: job.to, ok: false, suppressed: true, reason: offerBlockReason });
        }
        continue;
      }

      const inheritedIdempotencyDeadlineMs = Date.parse(job.resendIdempotencyDeadlineAt || "");
      const providerPreparationNow = logicalNow();
      if (job.resendIdempotencyDeadlineAt
          && (!Number.isFinite(inheritedIdempotencyDeadlineMs) || providerPreparationNow >= inheritedIdempotencyDeadlineMs)) {
        const expiredJob = {
          ...job,
          status: "failed",
          lastError: "delivery_outcome_unknown",
          failedAt: new Date(providerPreparationNow).toISOString(),
          updatedAt: new Date(providerPreparationNow).toISOString(),
        };
        const metric = await preProvider(() => recordMarketingCampaignMetric(job.campaignId, "failed", `dispatch:${id}:unknown`));
        const stored = metric.ok ? await preProvider(() => transitionJob(expiredJob, {
          expectedStatuses: ["queued"], mode: "terminal",
        })) : { ok: false };
        if (stored.ok) await preProvider(() => updateRecipientStatusStrict(job, "failed", { reason: expiredJob.lastError }));
        else await preProvider(() => redisCmd(["DEL", claimKey(id)]));
        failed += 1;
        results.push({ id, to: job.to, ok: false, permanent: stored.ok, reason: stored.ok ? expiredJob.lastError : "delivery_commit_pending" });
        continue;
      }

      const sendingJob = {
        ...job,
        status: "sending",
        attempts: Number(job.attempts || 0) + 1,
        resumeQueueScore: Number.isFinite(Number(job.queueScore)) ? Number(job.queueScore) : providerPreparationNow,
        queueScore: inflightRecoveryScore(providerPreparationNow),
        providerProtocolVersion: 2,
        marketingTokenIssuedAt: Number.isSafeInteger(Number(job.marketingTokenIssuedAt)) && Number(job.marketingTokenIssuedAt) > 0
          ? Number(job.marketingTokenIssuedAt)
          : Math.floor(providerPreparationNow / 1000),
        marketingTokenNonce: /^[a-f0-9]{24}$/i.test(String(job.marketingTokenNonce || ""))
          ? String(job.marketingTokenNonce).toLowerCase()
          : randomBytes(12).toString("hex"),
        resendFromAddress: validEmail(job.resendFromAddress) ? normalizeEmail(job.resendFromAddress) : normalizeEmail(mailFromAddress()),
        resendSiteUrl: clean(job.resendSiteUrl || process.env.SITE_URL || "https://www.liumeiti.vip", 300),
        updatedAt: new Date(now).toISOString(),
      };
      const sendingSaved = await preProvider(() => transitionJob(sendingJob, {
        expectedStatuses: ["queued"],
        mode: "keep",
        score: sendingJob.queueScore,
      }));
      if (!sendingSaved.ok) {
        await preProvider(() => redisCmd(["DEL", claimKey(id)]));
        failed += 1;
        results.push({ id, to: job.to, ok: false, retryable: true, reason: sendingSaved.error === "campaign_blocked" ? `campaign_${sendingSaved.campaignStatus}` : "storage_failed_before_send" });
        continue;
      }
      if (leaseLost) {
        const nextAttemptMs = now + RETRY_DELAY_MS;
        await preProvider(() => transitionJob({ ...job, status: "queued", queueScore: nextAttemptMs, nextAttemptAt: new Date(nextAttemptMs).toISOString(), updatedAt: new Date(now).toISOString() }, {
          expectedStatuses: ["sending"], mode: "schedule", score: nextAttemptMs,
        }));
        break;
      }
      if (typeof _testHooks?.beforeProvider === "function") {
        await _testHooks.beforeProvider({ campaignId: job.campaignId, campaignJobId: id });
      }
      if (!canContinue()) {
        deadlineExceeded = true;
        if (!await preProvider(() => requeueSendingForStop(job, sendingJob, id))) {
          failed += 1;
          results.push({ id, ok: false, retryable: true, reason: "delivery_commit_pending" });
        }
        break;
      }
      if (!(await preProvider(() => verifySendOwnership({ lockToken, job: sendingJob })))) {
        const currentRead = await preProvider(() => readRedis([["GET", campaignKey(job.campaignId)], ["GET", jobKey(id)]]));
        const candidateCampaign = currentRead.ok ? parseJson(currentRead.rows[0]) : null;
        const candidateJob = currentRead.ok ? parseJson(currentRead.rows[1]) : null;
        const currentCampaign = validCampaign(candidateCampaign, job.campaignId) ? candidateCampaign : null;
        const currentJob = validJob(candidateJob, id, job.campaignId) ? candidateJob : null;
        if (currentJob?.status === "sending" && currentCampaign?.status === "paused") {
          const nextAttemptMs = now + RETRY_DELAY_MS;
          await preProvider(() => transitionJob({ ...job, status: "queued", queueScore: nextAttemptMs, nextAttemptAt: new Date(nextAttemptMs).toISOString(), updatedAt: new Date(now).toISOString() }, {
            expectedStatuses: ["sending"], mode: "schedule", score: nextAttemptMs,
          }));
        } else if (currentJob?.status === "sending" && currentCampaign?.status === "cancelled") {
          await preProvider(() => transitionJob({ ...currentJob, status: "cancelled", cancelledAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }, {
            expectedStatuses: ["sending"], mode: "terminal",
          }));
        }
        await preProvider(() => redisCmd(["DEL", claimKey(id)]));
        results.push({ id, to: job.to, ok: true, skipped: true, reason: currentCampaign ? `campaign_${currentCampaign.status}` : "send_lease_lost" });
        continue;
      }
      const providerOfferBlockReason = offerDispatchBlockReason(
        campaign.offerSnapshot,
        Math.max(Number(now) || 0, Date.now()),
      );
      if (providerOfferBlockReason) {
        const suppression = await preProvider(() => suppressMarketingJob(sendingJob, providerOfferBlockReason, now, { expectedStatus: "sending" }));
        if (!suppression.ok) {
          await preProvider(() => redisCmd(["DEL", claimKey(id)]));
          failed += 1;
          results.push({ id, to: job.to, ok: false, retryable: true, reason: suppression.error });
        } else {
          results.push({ id, to: job.to, ok: false, suppressed: true, reason: providerOfferBlockReason });
        }
        continue;
      }
      if (!canContinue()) {
        deadlineExceeded = true;
        if (!await preProvider(() => requeueSendingForStop(job, sendingJob, id))) {
          failed += 1;
          results.push({ id, ok: false, retryable: true, reason: "delivery_commit_pending" });
        }
        break;
      }
      const providerDeadlineAt = Number(deadlineAt) > 0
        ? Math.max(0, Number(deadlineAt) - PROVIDER_COMMIT_RESERVE_MS)
        : 0;
      if (providerDeadlineAt > 0 && Date.now() + PROVIDER_MIN_START_BUDGET_MS >= providerDeadlineAt) {
        deadlineExceeded = true;
        if (!await preProvider(() => requeueSendingForStop(job, sendingJob, id))) {
          failed += 1;
          results.push({ id, ok: false, retryable: true, reason: "delivery_commit_pending" });
        }
        break;
      }
      const providerLogicalNow = logicalNow();
      const quotaReservation = await preProvider(() => reserveDailyProviderAttempt(sendingJob, providerLogicalNow));
      if (!quotaReservation.ok) {
        const nextAttemptMs = quotaReservation.dailyLimit
          ? nextBeijingDayStart(providerLogicalNow)
          : providerLogicalNow + RETRY_DELAY_MS;
        const requeued = await preProvider(() => transitionJob({
          ...job,
          status: "queued",
          queueScore: nextAttemptMs,
          nextAttemptAt: new Date(nextAttemptMs).toISOString(),
          updatedAt: new Date(providerLogicalNow).toISOString(),
        }, {
          expectedStatuses: ["sending"], mode: "schedule", score: nextAttemptMs,
        }));
        if (!requeued.ok) {
          await preProvider(() => redisCmd(["DEL", claimKey(id)]));
          failed += 1;
          results.push({ id, to: job.to, ok: false, retryable: true, reason: "quota_reservation_commit_pending" });
        } else {
          results.push({
            id,
            to: job.to,
            ok: true,
            skipped: true,
            reason: quotaReservation.dailyLimit ? "daily_limit" : "quota_storage_unavailable",
          });
        }
        break;
      }
      providerAttempts += 1;
      const providerDailyKey = quotaReservation.dailyKey;
      const providerTimestamp = new Date(providerLogicalNow).toISOString();
      const startedJob = {
        ...sendingJob,
        providerAttemptStartedAt: sendingJob.providerAttemptStartedAt || providerTimestamp,
        resendIdempotencyDeadlineAt: Number.isFinite(inheritedIdempotencyDeadlineMs)
          ? new Date(inheritedIdempotencyDeadlineMs).toISOString()
          : new Date(providerLogicalNow + RESEND_IDEMPOTENCY_RECOVERY_MS).toISOString(),
        updatedAt: providerTimestamp,
      };
      const startedSaved = await preProvider(() => transitionJob(startedJob, {
        expectedStatuses: ["sending"],
        mode: "keep",
        score: startedJob.queueScore,
      }));
      if (!startedSaved.ok) {
        await preProvider(() => redisCmd(["DEL", claimKey(id)]));
        failed += 1;
        results.push({ id, to: job.to, ok: false, retryable: true, reason: "provider_start_marker_pending" });
        continue;
      }
      if (typeof _testHooks?.afterQuotaReservation === "function") {
        await _testHooks.afterQuotaReservation({ campaignId: job.campaignId, campaignJobId: id });
      }
      const result = await sendSimpleEmail({
        to: job.to,
        subject: campaign.subject,
        html: campaign.html,
        text: campaign.text,
        fromName: campaign.brandName,
        marketing: true,
        category: "marketing",
        relatedType: "scheduled_campaign",
        relatedId: job.campaignId,
        campaignId: job.campaignId,
        idempotencyKey: job.id,
        support: campaign.support,
        locale: campaign.locale || "zh",
        siteUrl: startedJob.resendSiteUrl,
        fromAddress: startedJob.resendFromAddress,
        marketingTokenIssuedAt: startedJob.marketingTokenIssuedAt,
        marketingTokenNonce: startedJob.marketingTokenNonce,
        skipDeliveryTracking: true,
        forceProvider: "resend",
        deadlineAt: providerDeadlineAt,
      });
      if (result?.deadlineExceeded === true && result?.providerAttempted === false) {
        deadlineExceeded = true;
        const requeueCommit = await settleCommit(() => requeueSendingForStop(job, startedJob, id));
        if (!requeueCommit.settled) {
          results.push({ id, ok: true, skipped: true, retryable: true, reason: "provider_outcome_commit_deferred" });
        } else if (requeueCommit.error || !requeueCommit.value) {
          failed += 1;
          results.push({ id, ok: false, retryable: true, reason: "delivery_commit_pending" });
        } else {
          results.push({ id, ok: true, skipped: true, retryable: true, reason: "provider_not_started_requeued" });
        }
        break;
      }
      if (typeof _testHooks?.afterProviderBeforeRecord === "function") {
        await _testHooks.afterProviderBeforeRecord({ campaignId: job.campaignId, campaignJobId: id, result });
      }
      let deliveryRecord = null;
      const deliveryCommit = await commitProviderState(async () => {
        try { return await recordDispatch(startedJob, campaign, result); }
        catch { return null; }
      }, id, job.to);
      if (deliveryCommit.deferred) break;
      deliveryRecord = deliveryCommit.value;
      if (typeof _testHooks?.afterRecordBeforeState === "function") {
        await _testHooks.afterRecordBeforeState({
          campaignId: job.campaignId,
          campaignJobId: id,
          result,
          deliveryRecord,
        });
      }

      if (result?.suppressed) {
        const suppressedJob = {
          ...startedJob,
          status: "suppressed",
          lastError: clean(result.reason || "recipient_suppressed", 200),
          suppressedAt: providerTimestamp,
          updatedAt: providerTimestamp,
        };
        const metricCommit = await commitProviderState(
          () => recordMarketingCampaignMetric(job.campaignId, "suppressed", `dispatch:${id}`), id, job.to,
        );
        if (metricCommit.deferred) break;
        const metric = metricCommit.value;
        if (!metric.ok) {
          const claimCommit = await commitProviderState(() => redisCmd(["DEL", claimKey(id)]), id, job.to);
          if (claimCommit.deferred) break;
          failed += 1;
          results.push({ id, to: job.to, ok: false, retryable: true, reason: "metric_commit_pending" });
          continue;
        }
        const terminalCommit = await commitProviderState(
          () => transitionJob(suppressedJob, { expectedStatuses: ["sending"], mode: "terminal" }), id, job.to,
        );
        if (terminalCommit.deferred) break;
        const stored = terminalCommit.value;
        if (!stored.ok) {
          failed += 1;
          results.push({ id, to: job.to, ok: false, retryable: true, reason: "delivery_commit_pending" });
          continue;
        }
        const recipientCommit = await commitProviderState(
          () => updateRecipientStatusStrict(job, "suppressed", { reason: suppressedJob.lastError }), id, job.to,
        );
        if (recipientCommit.deferred) break;
        results.push({ id, to: job.to, ok: false, suppressed: true, reason: suppressedJob.lastError });
      } else if (result?.ok) {
        const completedJob = {
          ...startedJob,
          status: "submitted",
          provider: clean(result.provider || "resend", 30),
          providerMessageId: clean(result.messageId, 180),
          submittedAt: providerTimestamp,
          submittedAtBeijing: formatBeijingTime(providerLogicalNow),
          lastError: "",
          updatedAt: providerTimestamp,
        };
        const metricCommit = await commitProviderState(
          () => recordMarketingCampaignMetric(job.campaignId, "submitted", `dispatch:${id}`), id, job.to,
        );
        if (metricCommit.deferred) break;
        const metric = metricCommit.value;
        if (!metric.ok) {
          const claimCommit = await commitProviderState(() => redisCmd(["DEL", claimKey(id)]), id, job.to);
          if (claimCommit.deferred) break;
          failed += 1;
          results.push({ id, to: job.to, ok: false, retryable: true, deliveryRecorded: Boolean(deliveryRecord?.ok), reason: "metric_commit_pending" });
          continue;
        }
        const terminalCommit = await commitProviderState(() => transitionJob(completedJob, {
            expectedStatuses: ["sending"],
            mode: "terminal",
          }), id, job.to);
        if (terminalCommit.deferred) break;
        const stored = terminalCommit.value;
        if (!stored.ok) {
          failed += 1;
          results.push({ id, to: job.to, ok: false, retryable: true, deliveryRecorded: Boolean(deliveryRecord?.ok), reason: "delivery_commit_pending" });
          continue;
        }
        const recipientCommit = await commitProviderState(() => updateRecipientStatusStrict(job, "submitted", {
            provider: completedJob.provider,
            providerMessageId: completedJob.providerMessageId,
            submittedAt: completedJob.submittedAt,
          }), id, job.to);
        if (recipientCommit.deferred) break;
        submitted += 1;
        results.push({ id, to: job.to, ok: true, messageId: result.messageId || "" });
      } else {
        const quotaFailure = isQuotaFailure(result);
        const policyRetry = Boolean(result?.retryable || result?.policyUnavailable);
        const budgetDeferred = result?.deadlineExceeded === true && result?.retryDeferred === true;
        const lastError = clean(result?.reason || result?.error || result?.code || "send_failed", 200);
        // 配额失败是系统性原因(顺延到下个发送窗口),不计入永久失败次数。
        const idempotencyConflict = Boolean(result?.idempotencyConflict);
        const failedAttempts = Number(startedJob.failedAttempts || 0) + (quotaFailure || policyRetry ? 0 : 1);
        if (idempotencyConflict || (!quotaFailure && !policyRetry && failedAttempts >= MAX_SEND_ATTEMPTS)) {
          const deadJob = {
            ...startedJob,
            status: "failed",
            failedAttempts,
            lastError: idempotencyConflict ? "idempotency_payload_conflict" : lastError,
            failedAt: providerTimestamp,
            failedAtBeijing: formatBeijingTime(providerLogicalNow),
            updatedAt: providerTimestamp,
          };
          const metricCommit = await commitProviderState(
            () => recordMarketingCampaignMetric(job.campaignId, "failed", `dispatch:${id}`), id, job.to,
          );
          if (metricCommit.deferred) break;
          const metric = metricCommit.value;
          if (!metric.ok) {
            const claimCommit = await commitProviderState(() => redisCmd(["DEL", claimKey(id)]), id, job.to);
            if (claimCommit.deferred) break;
            failed += 1;
            results.push({ id, to: job.to, ok: false, retryable: true, reason: "metric_commit_pending" });
            continue;
          }
          const terminalCommit = await commitProviderState(
            () => transitionJob(deadJob, { expectedStatuses: ["sending"], mode: "terminal" }), id, job.to,
          );
          if (terminalCommit.deferred) break;
          const stored = terminalCommit.value;
          if (!stored.ok) {
            failed += 1;
            results.push({ id, to: job.to, ok: false, retryable: true, reason: "delivery_commit_pending" });
            continue;
          }
          const recipientCommit = await commitProviderState(
            () => updateRecipientStatusStrict(job, "failed", { reason: deadJob.lastError }), id, job.to,
          );
          if (recipientCommit.deferred) break;
          failed += 1;
          results.push({ id, to: job.to, ok: false, reason: deadJob.lastError, permanent: true });
        } else {
          const nextAttemptMs = retryTimestamp(result, providerLogicalNow);
          const retryBase = result?.uncertain
            ? startedJob
            : withoutProviderAttemptState(startedJob);
          const retryScore = result?.uncertain
            ? ambiguousRecoveryScore(Date.parse(startedJob.resendIdempotencyDeadlineAt || ""))
            : nextAttemptMs;
          const retryJob = {
            ...retryBase,
            status: "queued",
            queueScore: retryScore,
            failedAttempts,
            lastError,
            nextAttemptAt: new Date(nextAttemptMs).toISOString(),
            updatedAt: providerTimestamp,
          };
          const retryCommit = await commitProviderState(() => transitionJob(retryJob, {
            expectedStatuses: ["sending"], mode: "schedule", score: retryScore,
          }), id, job.to);
          if (retryCommit.deferred) break;
          const stored = retryCommit.value;
          if (budgetDeferred && stored.ok) {
            deadlineExceeded = true;
            results.push({ id, to: job.to, ok: true, skipped: true, retryable: true, reason: lastError });
            break;
          }
          if (quotaFailure) {
            const quotaCommit = await commitProviderState(
              () => redisCmd(["SET", providerDailyKey, String(DAILY_LIMIT), "EX", String(3 * 24 * 60 * 60)]), id, job.to,
            );
            if (quotaCommit.deferred) break;
          }
          failed += 1;
          results.push({ id, to: job.to, ok: false, retryable: true, reason: stored.ok ? lastError : "delivery_commit_pending" });
          if (quotaFailure) break;
        }
      }
      if (!canContinue()) {
        deadlineExceeded = true;
        break;
      }
      if (Number(interJobDelayMs) > 0) {
        const delayMs = Number(interJobDelayMs);
        if (Number(deadlineAt) > 0 && Date.now() + delayMs >= Number(deadlineAt)) {
          deadlineExceeded = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (removedInvalidQueueMembers || removedInvalidJobs) {
      console.warn("[marketing-queue] removed unreadable due queue entries", {
        invalidMembers: removedInvalidQueueMembers,
        invalidJobs: removedInvalidJobs,
      });
    }
    const safeResults = results.map(({ to: _recipient, ...item }) => item);
    return {
      ok: failed === 0 && !leaseLost && !deadlineExceeded,
      submitted,
      failed,
      results: safeResults,
      ...(leaseLost ? { reason: "lock_lost" } : {}),
      ...(deadlineExceeded ? {
        partial: true,
        deadlineExceeded: true,
        error: "maintenance_deadline_exceeded",
      } : {}),
    };
  } catch (error) {
    if (error !== PRE_PROVIDER_TIMEOUT) throw error;
    deadlineExceeded = true;
    return deadlineResult({ submitted, failed, results });
  } finally {
    clearInterval(heartbeat);
    await settleUntil(() => releaseDispatchLease(lockToken), Number(deadlineAt) > 0 ? Number(deadlineAt) : 0);
  }
}

export function normalizeMarketingBudgetResult(result) {
  if (result?.deadlineExceeded !== true
      || result?.error !== "maintenance_deadline_exceeded"
      || Number(result?.failed || 0) > 0
      || result?.leaseLost === true
      || result?.reason === "lock_lost") return result;
  const { deadlineExceeded: _deadline, partial: _partial, error: _error, ...completedSlice } = result;
  return { ...completedSlice, ok: true, deferred: true, reason: "maintenance_budget_exhausted" };
}

export const marketingCampaignQueueInternals = {
  DAILY_LIMIT,
  DISPATCH_LOCK_KEY,
  DISPATCH_LOCK_TTL_SECONDS,
  ENQUEUE_CONCURRENCY,
  MAX_SEND_ATTEMPTS,
  PROVIDER_COMMIT_RESERVE_MS,
  PROVIDER_MIN_START_BUDGET_MS,
  DISPATCH_RETURN_RESERVE_MS,
  QUEUE_KEY,
  beijingDayKey,
  deliveryMessageId,
  isQuotaFailure,
  makeJobId,
  nextBeijingEvening,
  retryTimestamp,
  offerDispatchBlockReason,
  releaseDispatchLease,
  renewDispatchLease,
  verifySendOwnership,
};
