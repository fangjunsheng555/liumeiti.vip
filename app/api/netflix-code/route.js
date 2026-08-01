import { createHash } from "node:crypto";
import {
  checkRateLimit,
  clean,
  getCookieFromRequest,
  getOrderById,
  getUser,
  rateLimitResponse,
  redisCmd,
  signSession,
  verifySession,
} from "../_utils.js";
import { orderExpirySummary } from "../../lib/order-expiry.js";
import { shouldAwaitAcceptedSibling } from "./_policy.js";
import {
  findLatestNetflixMailState,
  maskNetflixEmail,
  netflixAccountHash,
  netflixCodeLockKey,
  netflixCodeStoreConfigured,
  recordNetflixCodeAccess,
} from "./_store.js";

export const runtime = "nodejs";

function normalizeOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function normalizeEmail(value) {
  return clean(value, 200).trim().toLowerCase();
}

function netflixItem(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items.find((item) => String(item?.service || "").toLowerCase() === "netflix")
    || (String(order?.service || "").toLowerCase() === "netflix" ? order : null);
}

function effectiveNetflixAccount(order) {
  const item = netflixItem(order);
  return normalizeEmail(item?.staffAccount || item?.account || order?.staffAccount || order?.account);
}

async function accessForOrder(request, order, providedToken = "") {
  const userSession = verifySession(getCookieFromRequest(request, "lm_user"));
  const orderEmail = normalizeEmail(order?.email);
  if (userSession?.email && [orderEmail, normalizeEmail(order?.userEmail)].includes(normalizeEmail(userSession.email))) {
    return { ok: true, actorType: "user", email: normalizeEmail(userSession.email) };
  }
  const claim = verifySession(clean(providedToken, 4000));
  if (claim?.type === "after-sales-order"
    && normalizeOrderId(claim.orderId) === normalizeOrderId(order?.orderId)
    && normalizeEmail(claim.email) === orderEmail) {
    return { ok: true, actorType: "guest", email: orderEmail };
  }
  return { ok: false };
}

async function eligibility(order) {
  if (!order || !["received", "completed"].includes(order.status)) return { ok: false, error: "order_not_eligible" };
  if (!netflixItem(order)) return { ok: false, error: "netflix_order_required" };
  if (order.netflixSelfServiceEnabled === false) return { ok: false, error: "self_service_disabled" };
  const account = effectiveNetflixAccount(order);
  if (!account || !account.includes("@")) return { ok: false, error: "netflix_account_missing" };
  const expiry = orderExpirySummary(order);
  if (expiry?.expired) return { ok: false, error: "service_expired" };
  const ownerEmails = Array.from(new Set([order.email, order.userEmail].map(normalizeEmail).filter(Boolean)));
  const owners = await Promise.all(ownerEmails.map((email) => getUser(email)));
  if (owners.some((user) => user?.netflixSelfServiceDisabled)) return { ok: false, error: "self_service_disabled" };
  return { ok: true, account };
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

const RESULT_LINK_PATHS = {
  link: "/account/travel/verify",
  household: "/account/update-primary-location",
};

function safeResultLink(kind, value) {
  try {
    const expectedPath = RESULT_LINK_PATHS[kind];
    if (!expectedPath) return "";
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    return url.protocol === "https:"
      && (host === "netflix.com" || host.endsWith(".netflix.com"))
      && path === expectedPath
      ? url.toString()
      : "";
  } catch { return ""; }
}

function seenEventIdsFrom(body) {
  return Array.from(new Set((Array.isArray(body?.seenEventIds) ? body.seenEventIds : [])
    .map((value) => clean(value, 80).toUpperCase())
    .filter((value) => /^NM[A-F0-9]{24}$/.test(value))))
    .slice(0, 12);
}

async function logSuccessfulAccess(order, account, claim, outcome, eventId) {
  await recordNetflixCodeAccess({
    orderId: order?.orderId,
    userEmail: normalizeEmail(claim?.accessEmail || order?.userEmail || order?.email),
    accountEmail: normalizeEmail(account),
    outcome,
    eventId,
  });
}

export async function POST(request) {
  if (!netflixCodeStoreConfigured()) return Response.json({ ok: false, error: "service_not_configured" }, { status: 503 });
  const body = await readBody(request);
  const action = body.action === "retrieve" ? "retrieve" : "authorize";

  if (action === "authorize") {
    const orderId = normalizeOrderId(body.orderId);
    const order = await getOrderById(orderId);
    if (!order) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
    const access = await accessForOrder(request, order, body.token);
    if (!access.ok) return Response.json({ ok: false, error: "verification_required" }, { status: 401 });
    const eligible = await eligibility(order);
    if (!eligible.ok) return Response.json({ ok: false, error: eligible.error }, { status: 409 });
    const guard = await checkRateLimit(request, {
      namespace: "netflix-code:authorize",
      limit: 12,
      windowSec: 60 * 60,
      identity: `${orderId}|${access.email}`,
    });
    if (!guard.ok) return rateLimitResponse(guard, "请求过于频繁，请稍后再试");
    const startedAt = Date.now();
    const sessionToken = signSession({
      type: "netflix-code-session",
      orderId,
      accountHash: netflixAccountHash(eligible.account),
      actorType: access.actorType,
      accessEmail: access.email,
      startedAt,
      exp: startedAt + 15 * 60 * 1000,
    });
    return Response.json({
      ok: true,
      sessionToken,
      orderId,
      netflixAccount: eligible.account,
      accountHint: maskNetflixEmail(eligible.account),
      expiresIn: 15 * 60,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const claim = verifySession(clean(body.sessionToken, 4000));
  if (!claim || claim.type !== "netflix-code-session" || !claim.orderId || !claim.accountHash) {
    return Response.json({ ok: false, error: "session_expired" }, { status: 401 });
  }
  const order = await getOrderById(claim.orderId);
  if (!order) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  const eligible = await eligibility(order);
  if (!eligible.ok || netflixAccountHash(eligible.account) !== claim.accountHash) return Response.json({ ok: false, error: eligible.error || "account_changed" }, { status: 409 });
  const lockKey = netflixCodeLockKey(order.orderId);
  if (await redisCmd(["GET", lockKey]) === "blocked") return Response.json({ ok: false, error: "temporarily_locked" }, { status: 429 });
  const cycleId = createHash("sha256")
    .update(`${claim.orderId}|${claim.accountHash}|${claim.startedAt || "legacy"}`)
    .digest("hex")
    .slice(0, 24);
  const cycleKey = `${lockKey}:cycle:${cycleId}`;
  const firstPollInCycle = await redisCmd(["SET", cycleKey, "1", "NX", "EX", "900"]) === "OK";
  const attemptsKey = lockKey + ":attempts";
  if (firstPollInCycle) {
    const guard = await checkRateLimit(request, {
      namespace: "netflix-code:retrieve-cycle:v2",
      limit: 12,
      windowSec: 60 * 60,
      identity: `${order.orderId}|${claim.accountHash}`,
    });
    if (!guard.ok) {
      await redisCmd(["DEL", cycleKey]);
      return rateLimitResponse(guard, "获取次数过多，请稍后再试");
    }

    const attempts = Number(await redisCmd(["INCR", attemptsKey]) || 0);
    if (attempts === 1) await redisCmd(["EXPIRE", attemptsKey, "900"]);
    if (attempts > 12) {
      await redisCmd(["SET", lockKey, "blocked", "EX", "900"]);
      return Response.json({ ok: false, error: "temporarily_locked" }, { status: 429 });
    }
  }

  const mailState = await findLatestNetflixMailState(eligible.account, {
    since: Number(claim.startedAt || 0),
    excludeEventIds: seenEventIdsFrom(body),
  });
  if (mailState.state === "rejected") {
    if (shouldAwaitAcceptedSibling(mailState)) {
      return Response.json({ ok: true, pending: true, mailReceived: true, retryAfter: 6 }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: false, error: "mail_unrecognized", eventId: mailState.eventId || "" }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
  const result = mailState.state === "result" ? mailState.result : null;
  if (!result) return Response.json({ ok: true, pending: true, retryAfter: 6 }, { headers: { "Cache-Control": "no-store" } });
  if (result.kind === "code" && /^\d{4}$/.test(result.value)) {
    await redisCmd(["DEL", attemptsKey]);
    await logSuccessfulAccess(order, eligible.account, claim, "code_returned", result.eventId);
    return Response.json({ ok: true, kind: "code", code: result.value, expiresAt: result.expiresAt, receivedAtBeijing: result.receivedAtBeijing }, { headers: { "Cache-Control": "no-store" } });
  }
  if (result.kind === "link" || result.kind === "household") {
    const link = safeResultLink(result.kind, result.value);
    if (link) {
      await redisCmd(["DEL", attemptsKey]);
      const outcome = result.kind === "household" ? "household_link_returned" : "travel_link_returned";
      await logSuccessfulAccess(order, eligible.account, claim, outcome, result.eventId);
      return Response.json({ ok: true, kind: result.kind, url: link, expiresAt: result.expiresAt, receivedAtBeijing: result.receivedAtBeijing }, { headers: { "Cache-Control": "no-store" } });
    }
  }
  return Response.json({ ok: true, pending: true, retryAfter: 6 }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
