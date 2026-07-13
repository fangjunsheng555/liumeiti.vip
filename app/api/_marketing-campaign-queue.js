import { createHash } from "node:crypto";
import { registerEmailDelivery } from "./_mail-delivery.js";
import {
  clean,
  formatBeijingTime,
  pushAdminMailLog,
  redisCmd,
  redisPipeline,
  sendSimpleEmail,
  validEmail,
} from "./_utils.js";

const QUEUE_KEY = "lm:mail:marketing:queue";
const CAMPAIGN_PREFIX = "lm:mail:marketing:campaign:";
const JOB_PREFIX = "lm:mail:marketing:job:";
const CLAIM_PREFIX = "lm:mail:marketing:claim:";
const DISPATCH_LOCK_KEY = "lm:mail:marketing:dispatch-lock";
const DAILY_COUNT_PREFIX = "lm:mail:marketing:daily:";
const RECORD_TTL_SECONDS = 45 * 24 * 60 * 60;
const DAILY_LIMIT = 40;
const RETRY_DELAY_MS = 15 * 60 * 1000;

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

function safeCampaignId(value) {
  return clean(value, 80).replace(/[^A-Za-z0-9_-]/g, "");
}

function normalizeEmail(value) {
  const email = clean(value, 200).toLowerCase();
  return validEmail(email) ? email : "";
}

function campaignKey(campaignId) { return CAMPAIGN_PREFIX + safeCampaignId(campaignId); }
function jobKey(jobId) { return JOB_PREFIX + clean(jobId, 80); }
function claimKey(jobId) { return CLAIM_PREFIX + clean(jobId, 80); }

function makeJobId(campaignId, email, scheduledAt) {
  return createHash("sha256")
    .update(`${safeCampaignId(campaignId)}\u0000${normalizeEmail(email)}\u0000${scheduledAt}`)
    .digest("hex")
    .slice(0, 32);
}

function deliveryMessageId(jobId) { return `marketing-queue-${clean(jobId, 80)}`; }

function beijingDayKey(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
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

async function saveCampaign(campaign) {
  const rows = pipelineRows(await redisPipeline([
    ["SET", campaignKey(campaign.id), JSON.stringify(campaign), "EX", String(RECORD_TTL_SECONDS)],
  ]));
  return rows[0] === "OK";
}

async function saveJob(job, score, { onlyIfMissing = false } = {}) {
  const setCommand = ["SET", jobKey(job.id), JSON.stringify(job)];
  if (onlyIfMissing) setCommand.push("NX");
  setCommand.push("EX", String(RECORD_TTL_SECONDS));
  const rows = pipelineRows(await redisPipeline([
    setCommand,
    ["ZADD", QUEUE_KEY, "NX", String(score), job.id],
  ]));
  return rows[0] === "OK" && (Number(rows[1]) === 1 || Number(rows[1]) === 0);
}

async function updateJob(job, commands = []) {
  const rows = pipelineRows(await redisPipeline([
    ["SET", jobKey(job.id), JSON.stringify(job), "EX", String(RECORD_TTL_SECONDS)],
    ...commands,
  ]));
  return rows[0] === "OK";
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
  const campaign = {
    id,
    subject: clean(subject, 180),
    html: String(html || "").slice(0, 120000),
    text: String(text || "").slice(0, 12000),
    preview: clean(preview, 240),
    brandName: clean(brandName, 80),
    support: support && typeof support === "object" ? support : {},
    staffId: Number(actor?.staffId || 1),
    staffUsername: clean(actor?.staffUsername || "admin", 60),
    createdAt: new Date().toISOString(),
  };
  if (!(await saveCampaign(campaign))) {
    return { ok: false, error: "storage_failed", queuedCount: 0, failedCount: uniqueRecipients.length };
  }

  const results = [];
  for (const to of uniqueRecipients) {
    const idempotencyId = makeJobId(id, to, scheduledIso);
    const existing = parseJson(await redisCmd(["GET", jobKey(idempotencyId)]));
    if (existing && ["queued", "sending", "submitted"].includes(existing.status)) {
      results.push({ to, ok: true, duplicate: true, messageId: existing.deliveryMessageId || deliveryMessageId(idempotencyId) });
      continue;
    }

    const job = {
      id: idempotencyId,
      campaignId: id,
      to,
      scheduledAt: scheduledIso,
      status: "queued",
      attempts: Number(existing?.attempts || 0),
      deliveryMessageId: deliveryMessageId(idempotencyId),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const saved = await saveJob(job, scheduledMs, { onlyIfMissing: !existing });
    if (!saved) {
      results.push({ to, ok: false, reason: "storage_failed", messageId: job.deliveryMessageId });
      continue;
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
    results.push({ to, ok: true, duplicate: false, messageId: job.deliveryMessageId });
  }

  const queuedCount = results.filter((item) => item.ok).length;
  return {
    ok: queuedCount === uniqueRecipients.length,
    campaignId: id,
    scheduledAt: scheduledIso,
    queuedCount,
    failedCount: uniqueRecipients.length - queuedCount,
    results,
  };
}

async function recordDispatch(job, campaign, result) {
  const reason = result?.ok ? "" : clean(result?.reason || result?.error || result?.code || "send_failed", 200);
  await registerEmailDelivery({
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
      status: result?.ok ? "sent" : "failed",
      forceStatus: true,
    },
  });
  await pushAdminMailLog({
    to: job.to,
    subject: campaign.subject,
    content: campaign.preview,
    preview: campaign.preview,
    ok: Boolean(result?.ok),
    reason,
    messageId: result?.messageId || job.deliveryMessageId,
    staffId: campaign.staffId,
    staffUsername: campaign.staffUsername,
  });
}

export async function dispatchDueMarketingCampaigns({ now = Date.now(), limit = DAILY_LIMIT } = {}) {
  const acquired = await redisCmd(["SET", DISPATCH_LOCK_KEY, "1", "NX", "EX", "120"]);
  if (acquired !== "OK") return { ok: true, skipped: true, reason: "locked", submitted: 0, failed: 0 };

  let submitted = 0;
  let failed = 0;
  const results = [];
  try {
    const dailyKey = DAILY_COUNT_PREFIX + beijingDayKey(now);
    const alreadySubmitted = Number(await redisCmd(["GET", dailyKey]) || 0);
    const capacity = Math.max(0, Math.min(DAILY_LIMIT, Number(limit) || DAILY_LIMIT) - alreadySubmitted);
    if (!capacity) return { ok: true, skipped: true, reason: "daily_limit", submitted: 0, failed: 0 };

    const dueIds = await redisCmd([
      "ZRANGEBYSCORE",
      QUEUE_KEY,
      "-inf",
      String(now),
      "LIMIT",
      "0",
      String(capacity),
    ]);
    if (!Array.isArray(dueIds) || !dueIds.length) {
      return { ok: true, skipped: true, reason: "nothing_due", submitted: 0, failed: 0 };
    }

    for (const rawJobId of dueIds) {
      const id = clean(rawJobId, 80);
      if (!id) continue;
      const claimed = await redisCmd(["SET", claimKey(id), "1", "NX", "EX", "180"]);
      if (claimed !== "OK") continue;

      const job = parseJson(await redisCmd(["GET", jobKey(id)]));
      if (!job || job.status === "submitted") {
        await redisPipeline([["ZREM", QUEUE_KEY, id], ["DEL", claimKey(id)]]);
        continue;
      }
      const campaign = parseJson(await redisCmd(["GET", campaignKey(job.campaignId)]));
      if (!campaign) {
        const failedJob = { ...job, status: "failed", lastError: "campaign_missing", updatedAt: new Date(now).toISOString() };
        await updateJob(failedJob, [["ZREM", QUEUE_KEY, id], ["DEL", claimKey(id)]]);
        failed += 1;
        results.push({ id, to: job.to, ok: false, reason: "campaign_missing" });
        continue;
      }

      const sendingJob = {
        ...job,
        status: "sending",
        attempts: Number(job.attempts || 0) + 1,
        updatedAt: new Date(now).toISOString(),
      };
      await updateJob(sendingJob);
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
        idempotencyKey: job.id,
        support: campaign.support,
        skipDeliveryTracking: true,
      });
      await recordDispatch(job, campaign, result);

      if (result?.ok) {
        const completedJob = {
          ...sendingJob,
          status: "submitted",
          provider: clean(result.provider || "resend", 30),
          providerMessageId: clean(result.messageId, 180),
          submittedAt: new Date(now).toISOString(),
          submittedAtBeijing: formatBeijingTime(now),
          lastError: "",
          updatedAt: new Date(now).toISOString(),
        };
        await updateJob(completedJob, [
          ["ZREM", QUEUE_KEY, id],
          ["INCR", dailyKey],
          ["EXPIRE", dailyKey, String(3 * 24 * 60 * 60)],
          ["DEL", claimKey(id)],
        ]);
        submitted += 1;
        results.push({ id, to: job.to, ok: true, messageId: result.messageId || "" });
      } else {
        const nextAttemptMs = retryTimestamp(result, now);
        const retryJob = {
          ...sendingJob,
          status: "queued",
          lastError: clean(result?.reason || result?.error || result?.code || "send_failed", 200),
          nextAttemptAt: new Date(nextAttemptMs).toISOString(),
          updatedAt: new Date(now).toISOString(),
        };
        await updateJob(retryJob, [
          ["ZADD", QUEUE_KEY, String(nextAttemptMs), id],
          ["DEL", claimKey(id)],
        ]);
        failed += 1;
        results.push({ id, to: job.to, ok: false, reason: retryJob.lastError });
        if (isQuotaFailure(result)) {
          await redisCmd(["SET", dailyKey, String(DAILY_LIMIT), "EX", String(3 * 24 * 60 * 60)]);
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 550));
    }
    return { ok: failed === 0, submitted, failed, results };
  } finally {
    await redisCmd(["DEL", DISPATCH_LOCK_KEY]);
  }
}

export const marketingCampaignQueueInternals = {
  DAILY_LIMIT,
  QUEUE_KEY,
  beijingDayKey,
  deliveryMessageId,
  isQuotaFailure,
  makeJobId,
  nextBeijingEvening,
  retryTimestamp,
};
