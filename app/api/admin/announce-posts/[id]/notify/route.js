import { createHash, randomBytes } from "node:crypto";
import {
  adminActorFromSession,
  adminSessionFromRequest,
  clean,
  formatBeijingTime,
  getAllOrders,
  isRootAdminSession,
  pushAdminActionLog,
  pushAdminMailLog,
  redisCmd,
  sendSimpleEmail,
} from "../../../../_utils.js";
import { getMergedCatalog } from "../../../../_catalog.js";
import { getSettings } from "../../../../_settings.js";
import { buildServiceNoticeAudience, serviceNoticeAudienceSummary } from "../../../../_service-notices.js";
import { buildServiceNoticeEmail } from "../../../../service-notices/_email.js";
import { announcementContentVersion, findAnnouncementPost } from "../../_store.js";

export const runtime = "nodejs";
export const maxDuration = 60;

const SEND_LIMIT = 20;

function gate(request) {
  const session = adminSessionFromRequest(request);
  return session && isRootAdminSession(session) ? session : null;
}

function safeList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").toLowerCase()).filter(Boolean) : [];
}

function parseAudience(value) {
  try {
    const rows = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function noticeKeys(post) {
  const version = announcementContentVersion(post);
  const base = `lm:announce:notice:${post.id}:${version}`;
  return {
    version,
    audience: `${base}:audience`,
    sent: `${base}:sent`,
    attempted: `${base}:attempted`,
    failed: `${base}:failed`,
    lockPrefix: `${base}:lock:`,
  };
}

async function readAudience(post, freeze = false) {
  const keys = noticeKeys(post);
  const stored = await redisCmd(["GET", keys.audience]);
  if (stored) return { audience: parseAudience(stored), frozen: true, keys };
  const audience = buildServiceNoticeAudience(await getAllOrders(), post.affectedService);
  if (!freeze) return { audience, frozen: false, keys };
  await redisCmd(["SET", keys.audience, JSON.stringify(audience), "NX"]);
  const frozen = await redisCmd(["GET", keys.audience]);
  return { audience: parseAudience(frozen || JSON.stringify(audience)), frozen: true, keys };
}

async function deliveryState(keys, audience) {
  const [sentRows, attemptedRows, failedRows] = await Promise.all([
    redisCmd(["SMEMBERS", keys.sent]),
    redisCmd(["SMEMBERS", keys.attempted]),
    redisCmd(["HKEYS", keys.failed]),
  ]);
  const sent = new Set(safeList(sentRows));
  const attempted = new Set(safeList(attemptedRows));
  const failed = new Set(safeList(failedRows));
  const pendingRecipients = audience.filter((recipient) => !sent.has(recipient.email) && !attempted.has(recipient.email));
  return {
    sent,
    attempted,
    failed,
    pendingRecipients,
    counts: {
      total: audience.length,
      sent: sent.size,
      failed: failed.size,
      pending: pendingRecipients.length,
    },
  };
}

async function releaseLock(key, token) {
  const script = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  await redisCmd(["EVAL", script, "1", key, token]);
}

async function noticeContext(id, freeze = false) {
  const post = await findAnnouncementPost(id);
  if (!post) return { error: "announcement_not_found", status: 404 };
  if (!post.affectedService) return { error: "service_not_selected", status: 409 };
  const [catalog, audienceData] = await Promise.all([getMergedCatalog(), readAudience(post, freeze)]);
  const product = catalog.find((item) => item.key === post.affectedService);
  if (!product) return { error: "service_not_found", status: 409 };
  const summary = serviceNoticeAudienceSummary(audienceData.audience);
  const delivery = await deliveryState(audienceData.keys, audienceData.audience);
  return { post, product, summary, delivery, ...audienceData };
}

function responseData(context) {
  return {
    version: context.keys.version,
    frozen: context.frozen,
    service: { key: context.product.key, label: context.product.title },
    announcement: {
      id: context.post.id,
      title: context.post.title,
      titleEn: context.post.titleEn || "",
      published: context.post.published !== false,
    },
    audience: context.summary,
    delivery: context.delivery.counts,
    englishCopyReady: context.summary.en === 0 || Boolean(context.post.titleEn?.trim() && context.post.bodyEn?.trim()),
  };
}

export async function GET(request, { params }) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const context = await noticeContext(id, false);
  if (context.error) return Response.json({ ok: false, error: context.error }, { status: context.status });
  return Response.json({ ok: true, ...responseData(context) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request, { params }) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch {}
  const retry = body.retry === true;
  const { id } = await params;
  let context = await noticeContext(id, true);
  if (context.error) return Response.json({ ok: false, error: context.error }, { status: context.status });
  if (!context.post.title?.trim() || !context.post.body?.trim()) {
    return Response.json({ ok: false, error: "announcement_copy_required" }, { status: 409 });
  }
  if (context.summary.total === 0) return Response.json({ ok: false, error: "no_recipients" }, { status: 409 });
  if (context.summary.en > 0 && (!context.post.titleEn?.trim() || !context.post.bodyEn?.trim())) {
    return Response.json({ ok: false, error: "english_copy_required" }, { status: 409 });
  }

  const failedEmails = context.delivery.failed;
  const candidates = retry
    ? context.audience.filter((recipient) => failedEmails.has(recipient.email)).slice(0, SEND_LIMIT)
    : context.delivery.pendingRecipients.slice(0, SEND_LIMIT);
  if (candidates.length === 0) {
    return Response.json({ ok: true, ...responseData(context), sentNow: 0, failedNow: 0, hasMore: false });
  }

  const actor = adminActorFromSession(session);
  const settings = await getSettings();
  const siteDomain = process.env.SITE_DOMAIN || "www.liumeiti.vip";
  const siteUrl = process.env.SITE_URL || `https://${siteDomain}`;

  const results = await Promise.all(candidates.map(async (recipient) => {
    const emailHash = createHash("sha256").update(recipient.email).digest("hex").slice(0, 24);
    const lockKey = context.keys.lockPrefix + emailHash;
    const lockToken = randomBytes(12).toString("hex");
    const locked = await redisCmd(["SET", lockKey, lockToken, "NX", "EX", "120"]);
    if (locked !== "OK") return { skipped: true, ok: false, email: recipient.email };
    try {
      const locale = recipient.locale === "en" ? "en" : "zh";
      const brandName = (locale === "en" ? settings.brand.nameEn : settings.brand.name) || "冒央会社";
      const content = buildServiceNoticeEmail({
        post: context.post,
        service: context.product.key,
        serviceLabel: context.product.title,
        locale,
        brandName,
        siteDomain,
        siteUrl,
      });
      const result = await sendSimpleEmail({
        to: recipient.email,
        ...content,
        category: "service_incident",
        relatedType: "announcement",
        relatedId: String(context.post.id),
        fromName: brandName,
        support: settings.support,
        locale,
      });
      await redisCmd(["SADD", context.keys.attempted, recipient.email]);
      if (result?.ok) {
        await Promise.all([
          redisCmd(["SADD", context.keys.sent, recipient.email]),
          redisCmd(["HDEL", context.keys.failed, recipient.email]),
        ]);
      } else {
        await redisCmd(["HSET", context.keys.failed, recipient.email, JSON.stringify({
          reason: clean(result?.reason || result?.error || "send_failed", 160),
          at: new Date().toISOString(),
        })]);
      }
      await pushAdminMailLog({
        to: recipient.email,
        subject: content.subject,
        content: `${context.product.title}服务通知\n${context.post.title}`,
        preview: context.post.title,
        ok: Boolean(result?.ok),
        reason: result?.ok ? "" : (result?.reason || result?.error || "send_failed"),
        messageId: result?.messageId || "",
        staffId: actor.staffId,
        staffUsername: actor.staffUsername,
      });
      return { ok: Boolean(result?.ok), email: recipient.email };
    } finally {
      await releaseLock(lockKey, lockToken).catch(() => {});
    }
  }));

  const sentNow = results.filter((result) => result.ok).length;
  const failedNow = results.filter((result) => !result.ok && !result.skipped).length;
  await pushAdminActionLog({
    action: retry ? "service_notice_retry" : "service_notice_send",
    actor,
    target: `announcement:${context.post.id}`,
    detail: { service: context.product.key, attempted: candidates.length, sent: sentNow, failed: failedNow },
  });

  context = await noticeContext(id, true);
  const hasMore = !retry && context.delivery.counts.pending > 0;
  return Response.json({ ok: true, ...responseData(context), sentNow, failedNow, hasMore });
}
