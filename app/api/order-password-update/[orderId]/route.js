import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  checkRateLimit,
  clean,
  formatBeijingTime,
  getOrderEntryById,
  pushAdminActionLog,
  rateLimitResponse,
  redisCmd,
  setOrderAt,
  validEmail,
} from "../../_utils.js";
import { appendOrderTimelineOnce } from "../../_order-timeline.js";
import { deliverOnce } from "../../_delivery-once.js";
import { idempotencyPayloadHash, requiredIdempotencyKey } from "../../_money.js";
import { claimDurableOperation, completeDurableOperation } from "../../_durable-operation.js";

const RELEASE_ORDER_LOCK_SCRIPT = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

function bearerToken(request) {
  const value = request.headers.get("authorization") || "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

function tokenMatches(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const actual = createHash("sha256").update(token).digest();
  let expected;
  try { expected = Buffer.from(expectedHash, "hex"); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function findTarget(orderId, token) {
  const normalizedId = clean(orderId, 80).replace(/\s+/g, "").toUpperCase();
  if (!normalizedId || !token) return { error: "invalid_update_link" };
  // 按订单号直读单条记录 + 更新句柄,避免每次请求全量扫描订单库(legacy 订单自动带 legacyIndex)。
  const entry = await getOrderEntryById(normalizedId);
  if (!entry) return { error: "order_not_found" };
  if (entry.order.status === "invalid") return { error: "order_invalid" };
  let itemIndex = (entry.order.items || []).findIndex((item) => (
    item?.service === "spotify" && tokenMatches(token, item.passwordCorrectionTokenHash)
  ));
  let resolved = false;
  if (itemIndex < 0) {
    itemIndex = (entry.order.items || []).findIndex((item) => (
      item?.service === "spotify" && tokenMatches(token, item.passwordCorrectionResolvedTokenHash)
    ));
    resolved = itemIndex >= 0;
  }
  if (itemIndex < 0) return { error: "invalid_update_link" };
  const item = entry.order.items[itemIndex];
  const expiresAt = new Date(resolved
    ? item.passwordCorrectionResolvedTokenExpiresAt || item.passwordCorrectionResolvedAt || 0
    : item.passwordCorrectionExpiresAt || 0).getTime();
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return { error: "update_link_expired" };
  return { entry, item, itemIndex, resolved };
}

function publicDetails(order, item, itemIndex) {
  return {
    orderId: order.orderId,
    itemIndex,
    label: item.label || "Spotify",
    account: item.account || "",
    email: order.email || "",
    contact: order.contact || "",
    remark: order.remark || "",
    requestedAtBeijing: item.passwordCorrectionRequestedAtBeijing || "",
    updatedAtBeijing: item.customerPasswordUpdatedAtBeijing || "",
  };
}

async function notifySpotifyDetailsUpdated(order, item) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;

  const lines = [
    "Spotify 用户资料已更新",
    `订单: ${order.orderId}`,
    `商品: ${item.label || "Spotify"}`,
    `账号: ${item.account || "--"}`,
    `密码: ${item.password || "--"}`,
    `邮箱: ${order.email || "--"}`,
    `联系方式: ${order.contact || "--"}`,
  ];
  if (order.remark) lines.push(`备注: ${order.remark}`);
  lines.push(`更新时间: ${item.customerPasswordUpdatedAtBeijing || order.customerDetailsUpdatedAtBeijing || "--"}`);

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function GET(request, { params }) {
  const guard = await checkRateLimit(request, {
    namespace: "order-pw-update:read",
    limit: 30,
    windowSec: 10 * 60,
  });
  if (!guard.ok) return rateLimitResponse(guard, "请求过于频繁，请稍后再试");
  const { orderId } = await params;
  const target = await findTarget(orderId, bearerToken(request));
  if (target.error) {
    const status = target.error === "order_not_found" ? 404 : target.error === "order_invalid" ? 409 : 401;
    return Response.json({ ok: false, error: target.error }, { status });
  }
  return Response.json({
    ok: true,
    resolved: Boolean(target.resolved),
    details: publicDetails(target.entry.order, target.item, target.itemIndex),
  });
}

export async function PATCH(request, { params }) {
  const guard = await checkRateLimit(request, {
    namespace: "order-pw-update:write",
    limit: 15,
    windowSec: 10 * 60,
  });
  if (!guard.ok) return rateLimitResponse(guard, "提交过于频繁，请稍后再试");
  const { orderId: rawOrderId } = await params;
  const orderId = clean(rawOrderId, 80).replace(/\s+/g, "").toUpperCase();
  const token = bearerToken(request);
  let body = {};
  try { body = await request.json(); } catch {}
  const account = clean(body.account, 80);
  const password = clean(body.password, 120);
  const email = clean(body.email, 200).toLowerCase();
  const contact = clean(body.contact, 200);
  const remark = clean(body.remark, 1500);
  if (!account) return Response.json({ ok: false, error: "account_required" }, { status: 400 });
  if (!password) return Response.json({ ok: false, error: "password_required" }, { status: 400 });
  if (!validEmail(email)) return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  if (!contact) return Response.json({ ok: false, error: "contact_required" }, { status: 400 });
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  const requestHash = idempotencyPayloadHash({ orderId, account, password, email, contact, remark });
  const lockKey = `lm:order:update-lock:${orderId}`;
  const lockToken = randomBytes(18).toString("hex");
  const locked = await redisCmd(["SET", lockKey, lockToken, "NX", "EX", "120"]);
  if (locked !== "OK") return Response.json({ ok: false, error: "order_update_busy" }, { status: 409 });

  try {
    const target = await findTarget(orderId, token);
    if (target.error) {
      const status = target.error === "order_not_found" ? 404 : target.error === "order_invalid" ? 409 : 401;
      return Response.json({ ok: false, error: target.error }, { status });
    }
    const operation = await claimDurableOperation({
      scope: "spotify-password-update",
      principal: `${orderId}:${createHash("sha256").update(token).digest("hex")}`,
      idempotencyKey: idempotency.key,
      requestHash,
    });
    if (!operation.ok) {
      return Response.json({ ok: false, error: operation.error }, {
        status: operation.error === "idempotency_conflict" ? 409 : 503,
      });
    }
    if (operation.state === "done") {
      return Response.json({ ...(operation.record.result || { ok: true }), idempotent: true });
    }

    const { entry, item, itemIndex } = target;
    let persistedOrder = entry.order;
    let persistedItem = item;
    if (!target.resolved) {
      const expectedRevision = Number(entry.order.revision ?? 0);
      const now = new Date();
      const activeTokenHash = item.passwordCorrectionTokenHash;
      const activeTokenExpiresAt = item.passwordCorrectionExpiresAt;
      item.account = account;
      item.password = password;
      item.staffAccount = "";
      item.staffPassword = "";
      item.customerPasswordUpdatedAt = now.toISOString();
      item.customerPasswordUpdatedAtBeijing = formatBeijingTime(now);
      item.customerPasswordUpdateCount = Number(item.customerPasswordUpdateCount || 0) + 1;
      item.passwordCorrectionResolvedAt = now.toISOString();
      item.passwordCorrectionResolvedAtBeijing = formatBeijingTime(now);
      item.passwordCorrectionResolvedOperationId = operation.operationId;
      item.passwordCorrectionResolvedTokenHash = activeTokenHash;
      item.passwordCorrectionResolvedTokenExpiresAt = activeTokenExpiresAt;
      delete item.passwordCorrectionTokenHash;
      delete item.passwordCorrectionExpiresAt;
      entry.order.email = email;
      entry.order.contact = contact;
      entry.order.remark = remark;
      entry.order.customerDetailsUpdatedAt = now.toISOString();
      entry.order.customerDetailsUpdatedAtBeijing = formatBeijingTime(now);

      const saved = await setOrderAt(entry.index, entry.order, { expectedRevision });
      if (!saved) return Response.json({ ok: false, error: "stale_revision" }, { status: 409 });
      const latest = await getOrderEntryById(orderId);
      persistedOrder = latest?.order;
      persistedItem = persistedOrder?.items?.[itemIndex];
      if (!persistedOrder || persistedItem?.passwordCorrectionResolvedOperationId !== operation.operationId) {
        return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
      }
    }

    const effectOperationId = persistedItem.passwordCorrectionResolvedOperationId || operation.operationId;
    const timelineOk = await appendOrderTimelineOnce(orderId, `${effectOperationId}:timeline`, {
      type: "credentials_updated",
      visibility: "public",
      summaryZh: "用户已提交更新后的 Spotify 登录资料",
      summaryEn: "The customer submitted updated Spotify login details",
      actor: "customer",
    });
    const logOk = await pushAdminActionLog({
      action: "spotify_customer_details_updated",
      actor: { staffId: 0, staffUsername: "system" },
      target: "order:" + orderId,
      detail: { itemIndex },
      operationId: `${effectOperationId}:admin-log`,
    });
    const notice = await deliverOnce(
      `spotify-password-updated:${orderId}:${itemIndex}:${effectOperationId}:telegram`,
      () => notifySpotifyDetailsUpdated(persistedOrder, persistedItem),
    );
    if (!timelineOk || !logOk) {
      return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });
    }
    const responsePayload = {
      ok: true,
      details: publicDetails(persistedOrder, persistedItem, itemIndex),
      updatedAtBeijing: persistedItem.customerPasswordUpdatedAtBeijing,
      alreadySubmitted: Boolean(target.resolved),
      notification: { ok: Boolean(notice?.ok) },
    };
    const completed = await completeDurableOperation(operation, responsePayload);
    if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
    return Response.json(responsePayload);
  } finally {
    await redisCmd(["EVAL", RELEASE_ORDER_LOCK_SCRIPT, "1", lockKey, lockToken]);
  }
}
