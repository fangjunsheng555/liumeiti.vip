import { createHash } from "node:crypto";
import {
  checkRateLimit,
  clean,
  getOrderById,
  rateLimitResponse,
  redisCmd,
} from "../_utils.js";
import {
  authenticateUserRequest,
  readUserAuthState,
  signNetflixCodeSession,
  verifyAfterSalesToken,
  verifyNetflixCodeSession,
} from "../_auth-session.js";
import { orderExpirySummary } from "../../lib/order-expiry.js";
import { shouldAwaitAcceptedSibling } from "./_policy.js";
import { isNetflixOrderOwner, netflixOrderIdentity } from "./_ownership.js";
import { withApiTelemetry } from "../_observability.js";
import {
  findLatestNetflixMailState,
  maskNetflixEmail,
  netflixAccountHash,
  netflixCodeLockKey,
  netflixCodeStoreConfigured,
  markNetflixCodeResultReturned,
  recordNetflixCodeAccess,
} from "./_store.js";

export const runtime = "nodejs";

function normalizeOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase(); return email.length <= 254 && !/[\x00-\x1f\x7f]/.test(email) ? email : "";
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
  const userSession = await authenticateUserRequest(request);
  const { deliveryEmail } = netflixOrderIdentity(order);
  const orderEmail = deliveryEmail;
  // A delivery address is not an account principal. When a signed-in buyer
  // supplied a different receipt email, only that purchasing account owns the
  // self-service session. Guests continue through the order-bound after-sales
  // token below.
  if (userSession.ok && isNetflixOrderOwner(order, userSession.email)) {
    return { ok: true, actorType: "user", email: normalizeEmail(userSession.email) };
  }
  const claim = verifyAfterSalesToken(clean(providedToken, 4000));
  if (claim
    && normalizeOrderId(claim.orderId) === normalizeOrderId(order?.orderId)
    && normalizeEmail(claim.email) === orderEmail) {
    return { ok: true, actorType: "guest", email: orderEmail };
  }
  return { ok: false };
}

export async function eligibility(order) {
  if (!order || !["received", "completed"].includes(order.status)) return { ok: false, error: "order_not_eligible" };
  if (!netflixItem(order)) return { ok: false, error: "netflix_order_required" };
  if (order.netflixSelfServiceEnabled === false) return { ok: false, error: "self_service_disabled" };
  const account = effectiveNetflixAccount(order);
  if (!account || !account.includes("@")) return { ok: false, error: "netflix_account_missing" };
  const expiry = orderExpirySummary(order);
  if (expiry?.expired) return { ok: false, error: "service_expired" };
  const { ownerEmail } = netflixOrderIdentity(order);
  const ownerState = ownerEmail ? await readUserAuthState(ownerEmail) : null;
  // An order can legitimately outlive its account record, which historically
  // remained eligible. Store faults and corrupt records are different: do not
  // silently bypass an explicit per-user disable when its state cannot be read.
  if (ownerState && !ownerState.ok && ownerState.status !== 401) {
    return { ok: false, error: ownerState.error || "auth_store_unavailable", status: 503 };
  }
  const owner = ownerState?.ok ? ownerState.user : null;
  if (owner?.netflixSelfServiceDisabled) return { ok: false, error: "self_service_disabled" };
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

async function persistResultSafetyMarker(order, eventId) {
  return markNetflixCodeResultReturned(order?.orderId, eventId);
}

export function netflixMailStateErrorResponse(mailState) {
  if (mailState?.state !== "error") return null;
  return Response.json({ ok: false, error: mailState.error || "storage_unavailable" }, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}

async function postHandler(request) {
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
    if (!eligible.ok) return Response.json({ ok: false, error: eligible.error }, { status: eligible.status || 409 });
    const guard = await checkRateLimit(request, {
      namespace: "netflix-code:authorize",
      limit: 12,
      windowSec: 60 * 60,
      identity: `${orderId}|${access.email}`,
    });
    if (!guard.ok) return rateLimitResponse(guard, "请求过于频繁，请稍后再试");
    const startedAt = Date.now();
    const sessionToken = signNetflixCodeSession({
      orderId,
      accountHash: netflixAccountHash(eligible.account),
      actorType: access.actorType,
      accessEmail: access.email,
      startedAt,
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

  const claim = verifyNetflixCodeSession(clean(body.sessionToken, 4000));
  if (!claim || !claim.orderId || !claim.accountHash) {
    return Response.json({ ok: false, error: "session_expired" }, { status: 401 });
  }
  const order = await getOrderById(claim.orderId);
  if (!order) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  const eligible = await eligibility(order);
  if (!eligible.ok) return Response.json({ ok: false, error: eligible.error }, { status: eligible.status || 409 });
  if (netflixAccountHash(eligible.account) !== claim.accountHash) return Response.json({ ok: false, error: "account_changed" }, { status: 409 });
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
    orderId: order.orderId,
  });
  const storageError = netflixMailStateErrorResponse(mailState);
  if (storageError) return storageError;
  if (mailState.state === "rejected") {
    if (shouldAwaitAcceptedSibling(mailState)) {
      return Response.json({ ok: true, pending: true, mailReceived: true, retryAfter: 6 }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({
      ok: false,
      error: "mail_unrecognized",
      eventId: mailState.eventId || "",
      eventIds: Array.isArray(mailState.eventIds) ? mailState.eventIds : [],
    }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
  const result = mailState.state === "result" ? mailState.result : null;
  if (!result) return Response.json({ ok: true, pending: true, retryAfter: 6 }, { headers: { "Cache-Control": "no-store" } });
  if (result.kind === "code" && /^\d{4}$/.test(result.value)) {
    if (!await persistResultSafetyMarker(order, result.eventId)) {
      return Response.json({ ok: false, error: "result_safety_marker_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    await redisCmd(["DEL", attemptsKey]);
    await logSuccessfulAccess(order, eligible.account, claim, "code_returned", result.eventId);
    return Response.json({ ok: true, kind: "code", code: result.value, expiresAt: result.expiresAt, receivedAtBeijing: result.receivedAtBeijing }, { headers: { "Cache-Control": "no-store" } });
  }
  if (result.kind === "link" || result.kind === "household") {
    const link = safeResultLink(result.kind, result.value);
    if (link) {
      if (!await persistResultSafetyMarker(order, result.eventId)) {
        return Response.json({ ok: false, error: "result_safety_marker_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
      await redisCmd(["DEL", attemptsKey]);
      const outcome = result.kind === "household" ? "household_link_returned" : "travel_link_returned";
      await logSuccessfulAccess(order, eligible.account, claim, outcome, result.eventId);
      return Response.json({ ok: true, kind: result.kind, url: link, expiresAt: result.expiresAt, receivedAtBeijing: result.receivedAtBeijing }, { headers: { "Cache-Control": "no-store" } });
    }
  }
  return Response.json({ ok: true, pending: true, retryAfter: 6 }, { headers: { "Cache-Control": "no-store" } });
}

async function getHandler() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

export const POST = withApiTelemetry("netflix_code", postHandler);
export const GET = withApiTelemetry("netflix_code", getHandler);
