import { randomBytes } from "node:crypto";
import {
  getOrderEntryById, getOrderEntryByIdIncludingDeleted, setOrderAt, archiveOrderAt, orderArchiveEligibility,
  getCookieFromRequest, verifySession, adminActorFromRequest, adminActorLabel,
  pushAdminActionLog, formatBeijingTime, isRootAdminSession, adminPermissionProfile,
  clean, sendSimpleEmail, redisCmd, validEmail,
} from "../../../_utils.js";
import { beginOrderTransition, resumePendingOrderTransition } from "../../../_order-transition.js";
import { deliverOnce } from "../../../_delivery-once.js";
import { idempotencyPayloadHash, requiredIdempotencyKey } from "../../../_money.js";
import { claimDurableOperation, completeDurableOperation } from "../../../_durable-operation.js";
import { buildInvalidOrderEmailHtml, buildInvalidOrderEmailText } from "../../../order/invalid-email.js";
import { getSettings } from "../../../_settings.js";
import { supportText } from "../../../../lib/settings-defaults.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "请通过 QQ 2802632995 / WhatsApp +34 671143339 / Telegram @MaoyangSupport 联系在线客服";
const SUPPORT_CONTACT_EN = process.env.SUPPORT_CONTACT_EN
  || ("Reach our online support via " + SUPPORT_CONTACT.replace(/^请通过\s*/, "").replace(/\s*联系在线客服\s*$/, "").trim());

const RELEASE_ORDER_LOCK_SCRIPT = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

function adminSession(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin" ? session : null;
}

async function sendInvalidOrderEmail(order) {
  const emailLocale = order.locale === "en" ? "en" : "zh";
  const settings = await getSettings();
  const brandName = settings.brand.name || BRAND_NAME;
  const supportContact = supportText(settings.support, emailLocale);
  const html = buildInvalidOrderEmailHtml({
    order,
    brandName,
    siteDomain: SITE_DOMAIN,
    siteUrl: SITE_URL,
    supportContact,
    support: settings.support,
    locale: emailLocale,
  });
  const text = buildInvalidOrderEmailText({
    order,
    brandName,
    siteDomain: SITE_DOMAIN,
    siteUrl: SITE_URL,
    supportContact,
    locale: emailLocale,
  });
  return sendSimpleEmail({
    to: order.email,
    idempotencyKey: `order-invalid:${order.orderId}:${order.invalidAt || order.revision || 0}`,
    subject: emailLocale === "en"
      ? `Order ${order.orderId}: payment not received, marked invalid · ${brandName}`
      : `订单 ${order.orderId} 未收到付款，已标记无效 · ${brandName}`,
    text,
    html,
    fromName: brandName,
    support: settings.support,
    locale: emailLocale,
  });
}

async function deliverInvalidOrderEmail(order) {
  return deliverOnce(
    `order-invalid:${order.orderId}:${order.invalidAt || order.revision || 0}:email`,
    () => sendInvalidOrderEmail(order),
  );
}

// POST /api/admin/orders/batch
// body: { orderIds: string[], action: "delete" | "invalid" }
export async function POST(request) {
  const session = adminSession(request);
  if (!session) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const actor = adminActorFromRequest(request);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const orderIds = Array.isArray(body.orderIds)
    ? Array.from(new Set(body.orderIds
      .filter((value) => typeof value === "string")
      .map((value) => clean(value, 80).replace(/\s+/g, "").toUpperCase())
      .filter(Boolean)))
      .slice(0, 200)
    : [];
  const action = body.action === "delete" ? "delete" : body.action === "invalid" ? "invalid" : null;

  if (orderIds.length === 0) {
    return Response.json({ ok: false, error: "no_order_ids" }, { status: 400 });
  }
  if (!action) {
    return Response.json({ ok: false, error: "invalid_action" }, { status: 400 });
  }
  if (!adminPermissionProfile(session).canEditOrders) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (action === "delete" && !isRootAdminSession(session)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  const requestHash = idempotencyPayloadHash({ action, orderIds });
  let operation = await claimDurableOperation({
    scope: "admin-order-batch",
    principal: "orders",
    idempotencyKey: idempotency.key,
    requestHash,
  });
  if (!operation.ok) {
    return Response.json({ ok: false, error: operation.error }, {
      status: operation.error === "idempotency_conflict" ? 409 : 503,
    });
  }
  if (operation.state === "done") {
    return Response.json({ ...(operation.record.result || { ok: true, action }), idempotent: true });
  }
  const operationLockToken = randomBytes(18).toString("hex");
  const operationLocked = await redisCmd(["SET", operation.lockKey, operationLockToken, "NX", "EX", "600"]);
  if (operationLocked !== "OK") {
    return Response.json({ ok: false, error: "batch_operation_in_progress" }, { status: 409 });
  }

  try {
  // Re-read after the operation lock. A concurrent duplicate may have
  // completed between the initial durable lookup and lock acquisition.
  operation = await claimDurableOperation({
    scope: "admin-order-batch",
    principal: "orders",
    idempotencyKey: idempotency.key,
    requestHash,
  });
  if (!operation.ok) return Response.json({ ok: false, error: operation.error }, { status: 503 });
  if (operation.state === "done") {
    return Response.json({ ...(operation.record.result || { ok: true, action }), idempotent: true });
  }

  const results = [];
  for (const requestedOrderId of orderIds) {
    const itemOperationId = idempotencyPayloadHash({
      batchOperationId: operation.operationId,
      action,
      orderId: requestedOrderId,
    });
    const lockKey = `lm:order:update-lock:${clean(requestedOrderId, 80)}`;
    const lockToken = randomBytes(16).toString("hex");
    const locked = await redisCmd(["SET", lockKey, lockToken, "NX", "EX", "120"]);
    if (locked !== "OK") {
      results.push({ orderId: requestedOrderId, ok: false, error: "order_update_busy" });
      continue;
    }

    try {
      // Read only after taking the per-order lock. A pre-lock snapshot could
      // otherwise overwrite a concurrent single-order PATCH.
      let entry = await getOrderEntryById(requestedOrderId);
      if (!entry?.order && action === "delete") {
        const archivedEntry = await getOrderEntryByIdIncludingDeleted(requestedOrderId);
        if (archivedEntry?.order?.deleted && archivedEntry.order.archiveOperationId === itemOperationId) {
          results.push({
            orderId: requestedOrderId,
            ok: true,
            archived: true,
            idempotent: true,
            revision: Number(archivedEntry.order.revision || 0),
          });
          continue;
        }
      }
      if (!entry?.order) {
        results.push({ orderId: requestedOrderId, ok: false, error: "order_not_found" });
        continue;
      }
      if (entry.order.pendingTransition) {
        const resumed = await resumePendingOrderTransition(entry);
        if (!resumed.ok) {
          results.push({ orderId: requestedOrderId, ok: false, error: resumed.error || "order_transition_pending" });
          continue;
        }
        entry = await getOrderEntryById(requestedOrderId);
        if (!entry?.order) {
          results.push({ orderId: requestedOrderId, ok: false, error: "order_not_found" });
          continue;
        }
      }
      const currentRevision = Math.max(0, Number(entry.order.revision || 0));
    if (action === "delete") {
      const eligible = orderArchiveEligibility(entry.order);
      if (!eligible.ok) {
        results.push({ orderId: entry.order.orderId, ok: false, error: eligible.error });
        continue;
      }
      const archived = await archiveOrderAt(entry.index, entry.order, {
        deletedByStaffId: actor.staffId,
        deletedByStaffUsername: actor.staffUsername,
        archiveOperationId: itemOperationId,
      });
      results.push({
        orderId: entry.order.orderId,
        ok: archived.ok,
        archived: Boolean(archived.ok),
        revision: archived.ok ? currentRevision + 1 : currentRevision,
        ...(archived.ok ? {} : { error: archived.error || "delete_failed" }),
      });
    } else if (action === "invalid") {
      const originalOrder = entry.order;
      let order = JSON.parse(JSON.stringify(originalOrder));
      if (order.status !== "invalid") {
        const wasCompleted = order.status === "completed";
        const now = new Date();
        order.status = "invalid";
        order.invalidAt = now.toISOString();
        order.invalidAtBeijing = formatBeijingTime(now);
        order.completedAt = null;
        order.completedAtBeijing = null;
        // 返还占用的 AI 库存
        const transitionPlan = {
          restoreStock: (order.items || []).flatMap((item, itemIndex) => (
            item.stockReserved || item.aiStockReserved
              ? [{ index: itemIndex, service: item.service, plan: item.plan || item.rocketPlan }]
              : []
          )),
          reserveStock: [],
          refund: true,
          reclaim: false,
          settleCommission: false,
          reverseCommission: wasCompleted,
        };
        // 已完成订单被批量作废:回收已发返佣。
        // 退款闭环:余额/优惠券/兑换码(幂等)。
        order.staffAudit = Array.isArray(order.staffAudit) ? order.staffAudit : [];
        order.staffAudit.unshift({
          id: "OA" + Date.now().toString(36).toUpperCase(),
          staffId: actor.staffId,
          staffUsername: actor.staffUsername,
          label: adminActorLabel(actor),
          action: "batch_invalid",
          status: "invalid",
          createdAt: now.toISOString(),
          createdAtBeijing: formatBeijingTime(now),
        });
        order.staffAudit = order.staffAudit.slice(0, 30);
        order.revision = currentRevision + 1;
        const transitioned = await beginOrderTransition(
          { index: entry.index, order: originalOrder },
          order,
          transitionPlan,
          { mutationId: itemOperationId, mutationHash: requestHash, actor },
        );
        let ok = Boolean(transitioned.ok);
        let persistenceError = "";
        if (ok) order = transitioned.order;
        let invalidEmailResult = null;
        if (ok) {
          invalidEmailResult = await deliverInvalidOrderEmail(order);
          const noticeAt = new Date();
          order.invalidEmailNoticeAt = noticeAt.toISOString();
          order.invalidEmailNoticeAtBeijing = formatBeijingTime(noticeAt);
          order.invalidEmailNoticeOk = Boolean(invalidEmailResult?.ok);
          order.invalidEmailNoticeError = invalidEmailResult?.ok ? "" : clean(invalidEmailResult?.reason || invalidEmailResult?.error || "send_failed", 120);
          const noticeExpectedRevision = Number(order.revision);
          const noticeSaved = await setOrderAt(entry.index, order, { expectedRevision: noticeExpectedRevision });
          if (!noticeSaved) {
            const latestEntry = await getOrderEntryById(order.orderId);
            if (latestEntry?.order) order = latestEntry.order;
            ok = false;
            persistenceError = "stale_revision";
          }
        }
        results.push({
          orderId: entry.order.orderId,
          ok,
          revision: transitioned.ok ? Number(order.revision ?? currentRevision) : currentRevision,
          invalidNotice: invalidEmailResult,
          ...(ok ? {} : { error: persistenceError || transitioned.error || "order_transition_failed" }),
        });
      } else {
        let order = entry.order;
        let invalidEmailResult = null;
        let ok = true;
        let error = "";
        // A retry after the domain transition must finish a notification that
        // was interrupted before its durable marker was stored. Already
        // successful legacy notices are left untouched.
        if (!order.invalidEmailNoticeOk && validEmail(order.email)) {
          invalidEmailResult = await deliverInvalidOrderEmail(order);
          const noticeAt = new Date();
          order.invalidEmailNoticeAt = noticeAt.toISOString();
          order.invalidEmailNoticeAtBeijing = formatBeijingTime(noticeAt);
          order.invalidEmailNoticeOk = Boolean(invalidEmailResult?.ok);
          order.invalidEmailNoticeError = invalidEmailResult?.ok
            ? ""
            : clean(invalidEmailResult?.reason || invalidEmailResult?.error || "send_failed", 120);
          const noticeSaved = await setOrderAt(entry.index, order, { expectedRevision: currentRevision });
          if (!noticeSaved) {
            const latestEntry = await getOrderEntryById(order.orderId);
            if (latestEntry?.order) order = latestEntry.order;
            ok = false;
            error = "stale_revision";
          }
        }
        results.push({
          orderId: entry.order.orderId,
          ok,
          alreadyInvalid: true,
          revision: Number(order.revision ?? currentRevision),
          ...(invalidEmailResult ? { invalidNotice: invalidEmailResult } : {}),
          ...(ok ? {} : { error }),
        });
      }
      }
    } catch (error) {
      results.push({ orderId: requestedOrderId, ok: false, error: "batch_operation_failed" });
    } finally {
      await redisCmd(["EVAL", RELEASE_ORDER_LOCK_SCRIPT, "1", lockKey, lockToken]);
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const notFound = results.filter((result) => result.error === "order_not_found").map((result) => result.orderId);
  const matchedCount = results.length - notFound.length;
  const logOk = await pushAdminActionLog({
    action: "order_batch_" + action,
    actor,
    target: "orders:" + successCount,
    detail: { orderIds, successCount, notFound },
    operationId: `${operation.operationId}:admin-log`,
  });
  if (!logOk) return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });

  const responsePayload = {
    ok: true,
    action,
    matchedCount,
    successCount,
    failedCount: results.length - successCount,
    notFound,
    results,
  };
  const completed = await completeDurableOperation(operation, responsePayload);
  if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
  return Response.json(responsePayload);
  } finally {
    await redisCmd(["EVAL", RELEASE_ORDER_LOCK_SCRIPT, "1", operation.lockKey, operationLockToken]);
  }
}
