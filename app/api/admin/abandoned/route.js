// 后台「弃单召回」— 到了结算页但未完成下单的访客。仅超级管理员。
// 数据：/api/track 的 checkout_started 写入 lm:cart:v:<vid> + ZSET lm:cart:index；
// /api/order 成功后清除对应 vid。这里读取仍在索引里的（=未转化）记录。
import { randomBytes } from "node:crypto";
import {
  adminSessionFromRequest, isRootAdminSession, validEmail,
  redisCmd, redisPipeline, formatBeijingTime, mailFromAddress, sendSimpleEmail,
} from "../../_utils.js";
import { buildRecoveryEmailHtml, buildRecoveryEmailText } from "./recovery-email.js";
import { getSettings } from "../../_settings.js";
import { deliverOnce, recoverStaleSendingDelivery } from "../../_delivery-once.js";
import { getMailSendDecision } from "../../_mail-preferences.js";
import { reserveMarketingSendBudget } from "../../_marketing-campaign-queue.js";

export const runtime = "nodejs";
const CART_INDEX = "lm:cart:index";
const CART = "lm:cart:v:";
const MAIL_ATTEMPT = "lm:cart:mail-attempt:v1:";
const MAIL_ATTEMPT_TTL_SECONDS = 30 * 24 * 60 * 60;
const RESEND_RECOVERY_MS = 22 * 60 * 60 * 1000;
const STALE_DELIVERY_MS = 90 * 1000;
const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;

function unauth() { return Response.json({ ok: false, error: "unauthorized" }, { status: 401 }); }
function gate(request) { const s = adminSessionFromRequest(request); return s && isRootAdminSession(s) ? s : null; }
function flatToObj(v) {
  if (v && !Array.isArray(v) && typeof v === "object") return v;
  const o = {}; if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}
function row(id, h) {
  const ts = Number(h.ts || 0);
  let attr = null; try { attr = h.attr ? JSON.parse(h.attr) : null; } catch (e) {}
  return {
    id, email: h.email || "", services: h.services || "", amount: h.amount || "",
    status: h.status || "open", ip: h.ip || "",
    fromTool: !!(attr && attr.fromTool), source: attr ? (attr.utm_source || attr.referrer || (attr.fromTool ? "工具站" : "")) : "",
    ts, tsText: ts ? formatBeijingTime(ts) : "",
  };
}

const START_MAIL_ATTEMPT_SCRIPT = `
-- ABANDONED_MAIL_ATTEMPT_START_V1
local value=redis.call('TYPE',KEYS[1]); local actual=type(value)=='table' and value.ok or value
if actual~='string' then return redis.error_reply('abandoned_attempt_storage_type_error') end
local raw=redis.call('GET',KEYS[1])
if not raw or raw~=ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3])
return 1
`;

function abandonedDeliveryId(id) { return `abandoned:${id}:email`; }
function abandonedAttemptKey(id) { return `${MAIL_ATTEMPT}${id}`; }

function serializableObject(value) {
  try {
    const result = JSON.parse(JSON.stringify(value || {}));
    return result && typeof result === "object" && !Array.isArray(result) ? result : {};
  } catch { return {}; }
}

function buildAbandonedAttemptSnapshot({ id, to, subject, text, html, fromName, support, locale, now = Date.now() }) {
  const createdMs = Number.isSafeInteger(Number(now)) ? Number(now) : Date.now();
  let siteUrl = "https://www.liumeiti.vip";
  try { siteUrl = new URL(SITE_URL).origin; } catch {}
  return {
    version: 1,
    cartId: id,
    deliveryId: abandonedDeliveryId(id),
    recoveryTag: randomBytes(16).toString("hex"),
    phase: "prepared",
    createdAt: new Date(createdMs).toISOString(),
    to,
    subject: String(subject || ""),
    text: String(text || ""),
    html: String(html || ""),
    fromName: String(fromName || ""),
    support: serializableObject(support),
    locale: locale === "en" ? "en" : "zh",
    siteUrl,
    fromAddress: mailFromAddress(),
    marketingTokenIssuedAt: Math.floor(createdMs / 1000),
    marketingTokenNonce: randomBytes(12).toString("hex"),
    idempotencyKey: `${abandonedDeliveryId(id)}:${randomBytes(18).toString("hex")}`,
  };
}

function validAttemptSnapshot(value, id) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const createdMs = Date.parse(value.createdAt || "");
  if (value.version !== 1 || value.cartId !== id || value.deliveryId !== abandonedDeliveryId(id)) return false;
  if (!/^[a-f0-9]{32}$/.test(String(value.recoveryTag || ""))) return false;
  const idempotencyPrefix = `${abandonedDeliveryId(id)}:`;
  if (!String(value.idempotencyKey || "").startsWith(idempotencyPrefix)
      || !/^[a-f0-9]{36}$/.test(String(value.idempotencyKey).slice(idempotencyPrefix.length))) return false;
  if (!validEmail(value.to) || !Number.isFinite(createdMs)) return false;
  if (!["subject", "text", "html", "fromName", "siteUrl", "fromAddress"].every((field) => typeof value[field] === "string")) return false;
  if (!value.subject || !value.html || !validEmail(value.fromAddress)) return false;
  if (!value.support || typeof value.support !== "object" || Array.isArray(value.support)) return false;
  if (!Number.isSafeInteger(value.marketingTokenIssuedAt) || value.marketingTokenIssuedAt <= 0) return false;
  if (!/^[a-f0-9]{24}$/.test(String(value.marketingTokenNonce || ""))) return false;
  if (!["zh", "en"].includes(value.locale)) return false;
  try { if (new URL(value.siteUrl).origin !== value.siteUrl) return false; } catch { return false; }
  if (value.phase === "prepared") return !value.providerAttemptStartedAt && !value.resendIdempotencyDeadlineAt;
  if (!["provider_started", "definite_failure"].includes(value.phase)) return false;
  const startedMs = Date.parse(value.providerAttemptStartedAt || "");
  const deadlineMs = Date.parse(value.resendIdempotencyDeadlineAt || "");
  if (!Number.isFinite(startedMs) || !Number.isFinite(deadlineMs)
      || startedMs < createdMs || deadlineMs - startedMs !== RESEND_RECOVERY_MS) return false;
  if (value.phase === "provider_started") return !value.providerOutcomeClass;
  return ["suppressed", "policy_retry", "quota", "definite_failure"].includes(value.providerOutcomeClass)
    && Number.isFinite(Date.parse(value.providerFailedAt || ""));
}

function parseAttemptSnapshot(raw, id) {
  try {
    const snapshot = JSON.parse(String(raw || ""));
    return validAttemptSnapshot(snapshot, id) ? snapshot : null;
  } catch { return null; }
}

async function readAttemptSnapshot(id) {
  const raw = await redisCmd(["GET", abandonedAttemptKey(id)]);
  const snapshot = parseAttemptSnapshot(raw, id);
  return snapshot ? { ok: true, raw: String(raw), snapshot } : { ok: false, error: raw == null ? "attempt_missing" : "attempt_invalid" };
}

async function loadOrCreateAttemptSnapshot(candidate) {
  if (!validAttemptSnapshot(candidate, candidate?.cartId)) return { ok: false, error: "attempt_invalid" };
  const key = abandonedAttemptKey(candidate.cartId);
  const candidateRaw = JSON.stringify(candidate);
  const stored = await redisCmd(["SET", key, candidateRaw, "NX", "EX", String(MAIL_ATTEMPT_TTL_SECONDS)]);
  if (stored === "OK") return { ok: true, raw: candidateRaw, snapshot: candidate };
  return readAttemptSnapshot(candidate.cartId);
}

async function transitionAttemptSnapshot(current, next) {
  const nextRaw = JSON.stringify(next);
  const saved = await redisCmd([
    "EVAL", START_MAIL_ATTEMPT_SCRIPT, "1", abandonedAttemptKey(next.cartId),
    current.raw, nextRaw, String(MAIL_ATTEMPT_TTL_SECONDS),
  ]);
  if (Number(saved) === 1) return { ok: true, raw: nextRaw, snapshot: next };
  const reread = await readAttemptSnapshot(next.cartId);
  if (reread.ok && reread.raw === nextRaw) return reread;
  return { ok: false, error: "attempt_transition_unavailable" };
}

async function rotateDefiniteAttempt(current, now = Date.now()) {
  if (current.snapshot.phase !== "definite_failure") return current;
  const {
    providerAttemptStartedAt, resendIdempotencyDeadlineAt, providerOutcomeClass, providerFailedAt,
    ...base
  } = current.snapshot;
  const createdMs = Number(now);
  const next = {
    ...base,
    phase: "prepared",
    createdAt: new Date(createdMs).toISOString(),
    marketingTokenIssuedAt: Math.floor(createdMs / 1000),
    marketingTokenNonce: randomBytes(12).toString("hex"),
    idempotencyKey: `${current.snapshot.deliveryId}:${randomBytes(18).toString("hex")}`,
  };
  return transitionAttemptSnapshot(current, next);
}

async function ensureProviderStarted(current, now = Date.now()) {
  if (current.snapshot.phase === "provider_started") return current;
  const startedMs = Number(now);
  if (!Number.isSafeInteger(startedMs) || startedMs <= 0) return { ok: false, error: "invalid_provider_time" };
  const next = {
    ...current.snapshot,
    phase: "provider_started",
    providerAttemptStartedAt: new Date(startedMs).toISOString(),
    resendIdempotencyDeadlineAt: new Date(startedMs + RESEND_RECOVERY_MS).toISOString(),
  };
  return transitionAttemptSnapshot(current, next);
}

async function markDefiniteFailure(current, result, now = Date.now()) {
  let outcomeClass = result?.suppressed ? "suppressed"
    : result?.policyUnavailable ? "policy_retry"
      : Number(result?.code || 0) === 429 ? "quota"
        : "definite_failure";
  if (!["suppressed", "policy_retry", "quota", "definite_failure"].includes(outcomeClass)) {
    outcomeClass = "definite_failure";
  }
  return transitionAttemptSnapshot(current, {
    ...current.snapshot,
    phase: "definite_failure",
    providerOutcomeClass: outcomeClass,
    providerFailedAt: new Date(now).toISOString(),
  });
}

function beijingDay(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

export async function GET(request) {
  if (!gate(request)) return unauth();
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const total = Number((await redisCmd(["ZCARD", CART_INDEX])) || 0);
  const ids = (await redisCmd(["ZRANGE", CART_INDEX, String(offset), String(offset + limit - 1), "REV"])) || [];
  const rows = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = (await redisPipeline(chunk.map((id) => ["HGETALL", CART + id]))) || [];
    chunk.forEach((id, idx) => rows.push(row(id, flatToObj(res[idx] && res[idx].result))));
  }
  return Response.json({ ok: true, total, rows });
}

// POST — 单条操作：{id, action:"email"|"converted"}
export async function POST(request) {
  if (!gate(request)) return unauth();
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const id = String(body.id || "").replace(/[^a-f0-9]/g, "").slice(0, 32);
  const action = String(body.action || "");
  if (!id) return Response.json({ ok: false, error: "bad_id" }, { status: 400 });
  const ckey = CART + id;
  const h = flatToObj(await redisCmd(["HGETALL", ckey]));
  if (!h.ts) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  // 处理完从弃单索引移除该记录(召回过或已成交,不再显示在列表)
  async function removeRecord() {
    const result = await redisPipeline([["ZREM", CART_INDEX, id], ["DEL", ckey]]);
    return Array.isArray(result)
      && result.length === 2
      && result.every((entry) => entry && typeof entry === "object" && entry.result != null);
  }

  if (action === "converted") {
    if (!await removeRecord()) return Response.json({ ok: false, error: "storage_failed" }, { status: 503 });
    return Response.json({ ok: true, removed: true });
  }
  if (action === "email") {
    const to = (h.email || "").toLowerCase();
    if (!validEmail(to)) return Response.json({ ok: false, error: "no_email" }, { status: 400 });
    const services = h.services || "您挑选的服务";
    const locale = h.locale === "en" ? "en" : "zh";
    const en = locale === "en";
    // 品牌以站点设置为准
    const settings = await getSettings();
    const brandName = (en ? settings.brand.nameEn : settings.brand.name) || BRAND_NAME;
    const params = { services, amount: h.amount, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, support: settings.support, locale };
    const subject = en ? `Your ${brandName} order is one step away 🛒` : `您的订单还差一步就完成啦 🛒 · ${brandName}`;
    const html = buildRecoveryEmailHtml(params);
    const text = buildRecoveryEmailText(params);
    const candidate = buildAbandonedAttemptSnapshot({
      id, to, subject, text, html, fromName: brandName, support: settings.support, locale,
    });
    const preparedAttempt = await loadOrCreateAttemptSnapshot(candidate);
    if (!preparedAttempt.ok || preparedAttempt.snapshot.to !== to) {
      const changed = preparedAttempt.ok && preparedAttempt.snapshot.to !== to;
      return Response.json({ ok: false, error: changed ? "abandoned_record_changed" : "marketing_attempt_unavailable" }, { status: 503 });
    }
    const stableId = abandonedDeliveryId(id);
    const staleRecovery = await recoverStaleSendingDelivery(stableId, {
      recoveryTag: preparedAttempt.snapshot.recoveryTag,
      minimumAgeMs: STALE_DELIVERY_MS,
    });
    if (!staleRecovery.ok) {
      return Response.json({ ok: false, error: "delivery_journal_unavailable" }, { status: 503 });
    }
    const delivery = await deliverOnce(stableId, async () => {
      let attempt = await readAttemptSnapshot(id);
      if (!attempt.ok || attempt.snapshot.recoveryTag !== preparedAttempt.snapshot.recoveryTag) {
        return { ok: false, retryable: true, reason: "marketing_attempt_unavailable" };
      }
      const now = Date.now();
      attempt = await rotateDefiniteAttempt(attempt, now);
      if (!attempt.ok) return { ok: false, uncertain: true, reason: "delivery_attempt_transition_unknown" };
      if (attempt.snapshot.phase === "provider_started"
          && now >= Date.parse(attempt.snapshot.resendIdempotencyDeadlineAt || "")) {
        return { ok: false, uncertain: true, reason: "delivery_outcome_unknown" };
      }
      const policy = await getMailSendDecision({
        email: attempt.snapshot.to,
        purpose: "marketing",
        category: "marketing",
        marketing: true,
      });
      if (!policy.allowed) {
        const retryable = Boolean(policy.retryable || policy.policyUnavailable);
        return {
          ok: false,
          suppressed: !retryable,
          retryable,
          policyUnavailable: Boolean(policy.policyUnavailable),
          reason: policy.reason || (retryable ? "policy_unavailable" : "recipient_suppressed"),
        };
      }
      const budget = await reserveMarketingSendBudget({
        // Reserve once per logical Resend attempt and Beijing day. Recovery is
        // idempotent; a retry on a later day consumes that day's capacity.
        reservationId: `${attempt.snapshot.idempotencyKey}:${beijingDay(now)}`,
        now,
      });
      if (!budget.ok) {
        return {
          ok: false,
          retryable: true,
          dailyLimit: Boolean(budget.dailyLimit),
          reason: budget.dailyLimit ? "marketing_daily_limit" : "marketing_budget_unavailable",
        };
      }
      attempt = await ensureProviderStarted(attempt, now);
      if (!attempt.ok) return { ok: false, retryable: true, reason: "marketing_attempt_unavailable" };
      if (Date.now() >= Date.parse(attempt.snapshot.resendIdempotencyDeadlineAt || "")) {
        return { ok: false, uncertain: true, reason: "delivery_outcome_unknown" };
      }
      const result = await sendSimpleEmail({
        to: attempt.snapshot.to,
        subject: attempt.snapshot.subject,
        text: attempt.snapshot.text,
        html: attempt.snapshot.html,
        category: "marketing",
        marketing: true,
        relatedType: "abandoned",
        relatedId: id,
        campaignId: id,
        fromName: attempt.snapshot.fromName,
        support: attempt.snapshot.support,
        locale: attempt.snapshot.locale,
        siteUrl: attempt.snapshot.siteUrl,
        fromAddress: attempt.snapshot.fromAddress,
        marketingTokenIssuedAt: attempt.snapshot.marketingTokenIssuedAt,
        marketingTokenNonce: attempt.snapshot.marketingTokenNonce,
        idempotencyKey: attempt.snapshot.idempotencyKey,
        forceProvider: "resend",
      });
      if (result?.idempotencyConflict) {
        return { ...result, uncertain: true, reason: "idempotency_payload_conflict" };
      }
      if (!result?.ok && result?.uncertain !== true) {
        const recorded = await markDefiniteFailure(attempt, result);
        if (!recorded.ok) return { ok: false, uncertain: true, reason: "delivery_outcome_journal_unavailable" };
      }
      return result;
    }, { recoveryTag: preparedAttempt.snapshot.recoveryTag });
    const sent = delivery.ok === true
      && delivery.uncertain !== true
      && delivery.delivered === true;
    if (!sent) {
      const budgetFailure = delivery?.value?.reason;
      const storageFailure = ["marketing_attempt_unavailable", "marketing_budget_unavailable", "mail_policy_unavailable", "policy_unavailable"].includes(budgetFailure);
      return Response.json({
        ok: false,
        error: delivery.uncertain ? "delivery_result_uncertain" : (budgetFailure || "send_failed"),
        retryable: !delivery.uncertain,
      }, { status: delivery.uncertain || storageFailure ? 503 : (delivery?.value?.dailyLimit ? 429 : 502) });
    }
    // 召回邮件已发出 → 从列表移除
    if (!await removeRecord()) return Response.json({ ok: false, error: "storage_failed", sent: true }, { status: 503 });
    await redisCmd(["DEL", abandonedAttemptKey(id)]);
    return Response.json({ ok: true, removed: true });
  }
  return Response.json({ ok: false, error: "bad_action" }, { status: 400 });
}

// DELETE — 批量：{ ids:[...] } 或 { olderThanDays:30 }
export async function DELETE(request) {
  if (!gate(request)) return unauth();
  let body = {};
  try { body = await request.json(); } catch (e) {}
  let ids = [];
  if (Array.isArray(body.ids) && body.ids.length) {
    ids = body.ids.map((x) => String(x)).filter((x) => /^[a-f0-9]{8,32}$/.test(x)).slice(0, 5000);
  } else if (body.olderThanDays) {
    const cutoff = Date.now() - Math.max(1, Number(body.olderThanDays)) * 86400000;
    ids = (await redisCmd(["ZRANGE", CART_INDEX, String(cutoff), "0", "BYSCORE", "REV", "LIMIT", "0", "3000"])) || [];
  }
  if (!ids.length) return Response.json({ ok: true, deleted: 0 });
  const cmds = [];
  for (const id of ids) cmds.push(["ZREM", CART_INDEX, id], ["DEL", CART + id]);
  for (let i = 0; i < cmds.length; i += 300) await redisPipeline(cmds.slice(i, i + 300));
  return Response.json({ ok: true, deleted: ids.length });
}

export const abandonedDeliveryInternals = {
  MAIL_ATTEMPT_TTL_SECONDS,
  RESEND_RECOVERY_MS,
  STALE_DELIVERY_MS,
  abandonedAttemptKey,
  abandonedDeliveryId,
  buildAbandonedAttemptSnapshot,
};

export async function OPTIONS() { return new Response(null, { status: 204 }); }
