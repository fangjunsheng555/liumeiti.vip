import { createHash, randomBytes } from "node:crypto";
import {
  getOrderById, getOrderEntryById, getOrderEntryByIdIncludingDeleted, setOrderAt, archiveOrderAt, orderArchiveEligibility,
  getCookieFromRequest, verifySession, adminActorFromRequest, adminActorLabel,
  pushAdminActionLog, formatBeijingTime, clean, isRootAdminSession,
  sendSimpleEmail, adminPermissionProfile, validEmail,
  listAssignableAdminStaff, redisCmd,
  normalizeInternalReference, signSession,
} from "../../../_utils.js";
import { appendOrderTimelineOnce, getOrderTimeline } from "../../../_order-timeline.js";
import { buildCompletionEmailHtml, buildCompletionEmailText } from "../../../order/completion-email.js";
import { buildInvalidOrderEmailHtml, buildInvalidOrderEmailText } from "../../../order/invalid-email.js";
import { buildProxyOrderEmail } from "../../../quote-orders/_email.js";
import { getSettings } from "../../../_settings.js";
import { supportText } from "../../../../lib/settings-defaults.js";
import { buildSpotifyPasswordErrorEmail } from "../../../order-password-update/email.js";
import { effectiveQuoteStatus, normalizeQuoteValidDays } from "../../../_quote-expiry.js";
import { beginOrderTransition, resumePendingOrderTransition } from "../../../_order-transition.js";
import { getOrderSla } from "../../../../lib/order-sla.js";
import { deliverOnce } from "../../../_delivery-once.js";
import { idempotencyPayloadHash, requiredIdempotencyKey } from "../../../_money.js";
import { claimDurableOperation, completeDurableOperation } from "../../../_durable-operation.js";
import { enqueueOrderPushEvent } from "../../../_push.js";
import { appendBusinessTraceEvent, withApiTelemetry } from "../../../_observability.js";
import { readUserAuthState } from "../../../_auth-session.js";
import { netflixOrderIdentity } from "../../../netflix-code/_ownership.js";
import {
  applyThirdPartyNotice,
  buildDeliveryMessage,
  normalizeFulfillment,
} from "../../../../lib/order-fulfillment.js";
import { orderItemService } from "../../../../lib/netflix-delivery.js";

const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;
const STAFF_CREDENTIAL_SERVICES = new Set(["ai", "netflix", "disney", "max"]);

async function enqueueOrderUpdatePush(order, effects, operationId) {
  const jobs = [];
  if (effects?.credentialsChanged) {
    jobs.push(enqueueOrderPushEvent(order, "order.credentials_updated", operationId));
  }
  if (effects?.statusChanged) {
    jobs.push(enqueueOrderPushEvent(order, `order.${order.status}`, operationId));
  }
  if (!jobs.length) return [];
  try {
    return await Promise.all(jobs);
  } catch (error) {
    return [{ ok: false, error: clean(error?.message || "push_enqueue_failed", 120) }];
  }
}

async function traceAdminOrderBestEffort(order, event) {
  if (!order?.orderId) return;
  try {
    await appendBusinessTraceEvent(order.orderId, {
      businessTraceId: order.businessTraceId,
      ...event,
    });
  } catch {}
}
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "请通过 QQ 2802632995 / WhatsApp +34 671143339 / Telegram @MaoyangSupport 联系在线客服";
const SUPPORT_CONTACT_EN = process.env.SUPPORT_CONTACT_EN
  || ("Reach our online support via " + SUPPORT_CONTACT.replace(/^请通过\s*/, "").replace(/\s*联系在线客服\s*$/, "").trim());

async function deliverEmailOnce(key, sender) {
  const delivery = await deliverOnce(key, sender);
  const provider = delivery.value && typeof delivery.value === "object" ? delivery.value : {};
  return {
    ...provider,
    ok: Boolean(delivery.ok),
    delivered: delivery.delivered === true,
    handled: Boolean(delivery.ok && (delivery.delivered || delivery.terminal || delivery.suppressed || delivery.skipped)),
    suppressed: Boolean(delivery.suppressed || provider.suppressed),
    terminal: Boolean(delivery.terminal),
    idempotent: Boolean(delivery.idempotent),
    pending: Boolean(delivery.pending),
    uncertain: Boolean(delivery.uncertain),
    error: delivery.error || provider.error || "",
  };
}

function mutationLinkToken(kind, orderId, mutationId, mutationHash, itemIndex = -1) {
  return signSession({ typ: kind, orderId: normalizedOrderId(orderId), mutationId, mutationHash, itemIndex });
}

function legacyOrderItem(order) {
  const account = order?.account || "";
  const staffAccount = order?.staffAccount || "";
  return {
    service: order?.service || "",
    label: order?.serviceLabel || "",
    cycle: order?.cycle || "",
    amount: Number(order?.finalAmount || 0),
    plan: order?.plan || order?.rocketPlan || "",
    planLabel: order?.planLabel || order?.rocketPlanLabel || "",
    platformUrl: order?.platformUrl || "",
    productPrice: order?.productPrice || "",
    account,
    password: order?.password || "",
    staffAccount,
    staffPassword: order?.staffPassword || "",
    subscriptionLinks: order?.service === "rocket" && (staffAccount || account)
      ? subscriptionLinks(staffAccount || account)
      : null,
  };
}

function orderItemsForAdmin(order) {
  const source = Array.isArray(order?.items) && order.items.length > 0
    ? order.items
    : [legacyOrderItem(order)];
  return source.map(({ passwordCorrectionTokenHash, ...item }) => item);
}

function missingCompletionCredential(order, itemUpdates = [], netflixSelfServiceDelivery = order?.netflixDeliveryMode === "self_service") {
  const items = Array.isArray(order?.items) && order.items.length > 0
    ? order.items
    : [legacyOrderItem(order)];
  const updates = new Map();
  for (const update of Array.isArray(itemUpdates) ? itemUpdates : []) {
    const index = Number(update?.index);
    if (Number.isInteger(index) && index >= 0) updates.set(index, update);
  }
  let netflixLoginEmail = "";
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const service = orderItemService(order, item, index);
    if (!STAFF_CREDENTIAL_SERVICES.has(service)) continue;
    const update = updates.get(index);
    const originalStaffAccount = item?.staffAccount || (index === 0 ? order?.staffAccount : "");
    const originalStaffPassword = item?.staffPassword || (index === 0 ? order?.staffPassword : "");
    const staffAccount = clean(typeof update?.staffAccount === "string" ? update.staffAccount : originalStaffAccount, 80);
    const staffPassword = clean(typeof update?.staffPassword === "string" ? update.staffPassword : originalStaffPassword, 120);
    if (service === "netflix" && netflixSelfServiceDelivery) {
      const loginEmail = staffAccount
        || clean(item?.account, 80)
        || (index === 0 ? clean(order?.staffAccount || order?.account, 80) : "");
      if (validEmail(loginEmail)) {
        const normalizedLoginEmail = loginEmail.toLowerCase();
        if (netflixLoginEmail && netflixLoginEmail !== normalizedLoginEmail) {
          return {
            index,
            label: clean(item?.label || item?.service || `#${index + 1}`, 180),
            reason: "netflix_account_conflict",
          };
        }
        netflixLoginEmail = normalizedLoginEmail;
        continue;
      }
      return {
        index,
        label: clean(item?.label || item?.service || `#${index + 1}`, 180),
        reason: "netflix_email_required",
      };
    }
    if (staffAccount && staffPassword) continue;
    return {
      index,
      label: clean(item?.label || item?.service || `#${index + 1}`, 180),
    };
  }
  return null;
}

function completionCredentialsChanged(order, itemUpdates = []) {
  const items = Array.isArray(order?.items) && order.items.length > 0
    ? order.items
    : [legacyOrderItem(order)];
  return (Array.isArray(itemUpdates) ? itemUpdates : []).some((update) => {
    const index = Number(update?.index);
    const item = Number.isInteger(index) && index >= 0 ? items[index] : null;
    if (!item || !STAFF_CREDENTIAL_SERVICES.has(orderItemService(order, item, index))) return false;
    return [
      ["account", 80],
      ["password", 120],
      ["staffAccount", 80],
      ["staffPassword", 120],
    ].some(([field, max]) => typeof update?.[field] === "string"
      && clean(update[field], max) !== clean(item?.[field], max));
  });
}

async function netflixUserSelfServiceState(order) {
  const { ownerEmail } = netflixOrderIdentity(order);
  if (!ownerEmail) return { ok: true, disabled: false };
  const state = await readUserAuthState(ownerEmail);
  if (state?.ok) return { ok: true, disabled: Boolean(state.user?.netflixSelfServiceDisabled) };
  if (state?.status === 401) return { ok: true, disabled: false };
  return { ok: false, disabled: true, error: state?.error || "auth_store_unavailable" };
}

function orderForAdminResponse(order) {
  const status = effectiveQuoteStatus(order);
  const response = {
    ...order,
    status,
    sla: getOrderSla({ ...order, status }),
    items: orderItemsForAdmin(order),
  };
  delete response.quotePaymentTokenHash;
  return response;
}

function adminSession(request) {
  const token = getCookieFromRequest(request, "lm_admin");
  const session = verifySession(token);
  return session && session.role === "admin" ? session : null;
}

function adminOk(request) {
  return Boolean(adminSession(request));
}

function normalizedOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

async function sendCompletionEmail(order) {
  {
    if (!order.email) return { ok: false, reason: "order_email_missing" };
    const emailLocale = order.locale === "en" ? "en" : "zh";
    const settings = await getSettings();
    const brandName = settings.brand.name || BRAND_NAME;
    if (order.orderType === "proxy_payment") {
      const content = buildProxyOrderEmail({
        kind: "completed", order, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, locale: emailLocale, support: settings.support,
      });
      return sendSimpleEmail({
        to: order.email,
        idempotencyKey: `order-completed:${order.orderId}:${order.revision || 0}`,
        ...content,
        category: "order_update",
        relatedType: "order",
        relatedId: order.orderId,
        fromName: brandName,
        support: settings.support,
        locale: emailLocale,
      });
    }
    const netflixUserState = order.netflixDeliveryMode === "self_service"
      ? await netflixUserSelfServiceState(order)
      : { ok: true, disabled: false };
    const emailOrder = !netflixUserState.ok || netflixUserState.disabled
      ? { ...order, netflixSelfServiceEnabled: false }
      : order;
    const supportContact = supportText(settings.support, emailLocale);
    const html = buildCompletionEmailHtml({
      order: emailOrder, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, supportContact, support: settings.support, locale: emailLocale,
    });
    const text = buildCompletionEmailText({
      order: emailOrder, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, locale: emailLocale,
    });
    const subject = emailLocale === "en"
      ? `🎉 Order ${order.orderId} is ready · ${brandName}`
      : `🎉 订单 ${order.orderId} 已开通 · ${brandName}`;
    const result = await sendSimpleEmail({
      to: order.email,
      idempotencyKey: `order-completed:${order.orderId}:${order.revision || 0}`,
      subject,
      text,
      html,
      category: "order_update",
      relatedType: "order",
      relatedId: order.orderId,
      fromName: brandName,
      support: settings.support,
      locale: emailLocale,
    });
    if (result.ok) console.log(`[completion-email] sent to ${order.email} via ${result.provider || "smtp"} (msg=${result.messageId})`);
    else console.error("[completion-email] failed:", result.reason || result.error || result.code || "send_failed");
    return result;
  }

}

async function sendProxyQuoteEmail(order, paymentUrl) {
  const settings = await getSettings();
  const brandName = settings.brand.name || BRAND_NAME;
  const content = buildProxyOrderEmail({
    kind: "quote",
    order,
    paymentUrl,
    brandName,
    siteDomain: SITE_DOMAIN,
    siteUrl: SITE_URL,
    locale: order.locale === "en" ? "en" : "zh",
    support: settings.support,
  });
  return sendSimpleEmail({
    to: order.email,
    idempotencyKey: `order-quote:${order.orderId}:${order.revision || 0}`,
    ...content,
    category: "quote",
    relatedType: "quote",
    relatedId: order.orderId,
    fromName: brandName,
    support: settings.support,
    locale: order.locale === "en" ? "en" : "zh",
  });
}

async function sendTelegramNotice(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
  });
  if (res.ok) return true;
  return res.status >= 500 || res.status === 408 || res.status === 425
    ? { ok: false, uncertain: true, error: `telegram_http_${res.status}` }
    : { ok: false, retryable: true, error: `telegram_http_${res.status}` };
}

async function getOrderHandler(request, { params }) {
  const session = adminSession(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canViewOrders) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const { orderId } = await params;
  const order = await getOrderById(orderId);
  if (!order) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  const timeline = await getOrderTimeline(order);
  return Response.json(
    { ok: true, order: orderForAdminResponse(order), timeline },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// PATCH /api/admin/orders/:orderId
// body: { status, staffNotes, internalNotes, deliveryMessageMode,
//   thirdPartyPlatformNotice, items: [{index, account, password, staffAccount, staffPassword, fulfillment}] }
async function updateOrderHandler(request, { params }) {
  const session = adminSession(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canEditOrders) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const actor = adminActorFromRequest(request);

  const { orderId } = await params;
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  const mutationId = idempotency.key;
  const mutationHash = idempotencyPayloadHash(body || {});
  const canonicalOrderId = normalizedOrderId(orderId);
  const operationPrincipal = canonicalOrderId;

  if (body.action === "claim" || body.action === "assign") {
    const lockKey = `lm:order:update-lock:${canonicalOrderId}`;
    const lockToken = randomBytes(12).toString("hex");
    const locked = await redisCmd(["SET", lockKey, lockToken, "NX", "EX", "120"]);
    if (locked !== "OK") {
      return Response.json({ ok: false, error: "assignment_busy" }, { status: 409 });
    }
    try {
      const operation = await claimDurableOperation({
        scope: "admin-order-patch",
        principal: operationPrincipal,
        idempotencyKey: mutationId,
        requestHash: mutationHash,
      });
      if (!operation.ok) {
        return Response.json({ ok: false, error: operation.error }, {
          status: operation.error === "idempotency_conflict" ? 409 : 503,
        });
      }
      if (operation.state === "done") {
        return Response.json({ ...(operation.record.result || { ok: true }), idempotent: true });
      }
      let entry = await getOrderEntryById(orderId);
      if (!entry?.order || entry.order.deleted) {
        return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
      }
      if (entry.order.pendingTransition) {
        const resumed = await resumePendingOrderTransition(entry);
        if (!resumed.ok) return Response.json({ ok: false, error: resumed.error || "order_transition_pending" }, { status: 503 });
        entry = await getOrderEntryById(orderId);
        if (!entry?.order) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
      }
      const order = entry.order;
      const expectedRevision = Number(order.revision ?? 0);
      const processedMutations = Array.isArray(order.processedMutations) ? order.processedMutations : [];
      const priorMutation = processedMutations.find((item) => (
        item?.id === mutationId && (!item.principal || item.principal === operationPrincipal)
      ));
      if (priorMutation) {
        if (priorMutation.hash !== mutationHash) {
          return Response.json({ ok: false, error: "idempotency_conflict" }, { status: 409 });
        }
        const assignmentEffect = priorMutation.effects?.assignment || {};
        const targetUsername = order.assignedStaffUsername || assignmentEffect.assignedStaffUsername || "";
        const timelineOk = await appendOrderTimelineOnce(
          order.orderId,
          `${operation.operationId}:assignment-timeline`,
          {
            type: Number(order.assignedStaffId || 0) ? "assigned" : "unassigned",
            visibility: "internal",
            summaryZh: Number(order.assignedStaffId || 0) ? `负责人已更新为 ${targetUsername}` : "已取消订单负责人",
            summaryEn: Number(order.assignedStaffId || 0) ? `Assigned to ${targetUsername}` : "Order unassigned",
            actor: actor.staffUsername,
          },
        );
        const logOk = await pushAdminActionLog({
          action: assignmentEffect.action || (Number(order.assignedStaffId || 0) ? "order_assign" : "order_unassign"),
          actor,
          target: "order:" + canonicalOrderId,
          detail: assignmentEffect,
          operationId: `${operation.operationId}:assignment-admin-log`,
        });
        if (!timelineOk || !logOk) {
          return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });
        }
        const replayPayload = {
          ok: true,
          order: orderForAdminResponse(order),
          assignment: {
            staffId: Number(order.assignedStaffId || 0),
            username: order.assignedStaffUsername || "",
            assignedAt: order.assignedAt || "",
            assignedAtBeijing: order.assignedAtBeijing || "",
          },
        };
        const completed = await completeDurableOperation(operation, replayPayload);
        if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
        return Response.json({ ...replayPayload, idempotent: true });
      }
      if (body.expectedRevision != null && Number(body.expectedRevision) !== expectedRevision) {
        return Response.json({ ok: false, error: "stale_revision", mutationApplied: false, currentRevision: expectedRevision }, { status: 409 });
      }
      const previousStaffId = Number(order.assignedStaffId || 0);
      const previousStaffUsername = order.assignedStaffUsername || "";
      let target = null;

      if (body.action === "claim") {
        if (previousStaffId && previousStaffId !== actor.staffId) {
          return Response.json({
            ok: false,
            error: "order_already_assigned",
            assignment: { staffId: previousStaffId, username: previousStaffUsername },
          }, { status: 409 });
        }
        target = { id: actor.staffId, username: actor.staffUsername };
      } else {
        const targetId = Number(body.assignedStaffId || 0);
        if (targetId > 0) {
          const staff = await listAssignableAdminStaff();
          target = staff.find((item) => Number(item.id) === targetId) || null;
          if (!target) return Response.json({ ok: false, error: "staff_not_assignable" }, { status: 400 });
        }
      }

      const now = new Date();
      order.assignedStaffId = Number(target?.id || 0);
      order.assignedStaffUsername = target?.username || "";
      order.assignedAt = target ? now.toISOString() : "";
      order.assignedAtBeijing = target ? formatBeijingTime(now) : "";
      order.assignedByStaffId = actor.staffId;
      order.assignedByStaffUsername = actor.staffUsername;
      if (previousStaffId !== Number(target?.id || 0)) {
        order.slaReminderKey = "";
        order.slaReminderSentAt = "";
        order.slaReminderSentAtBeijing = "";
      }
      order.staffAudit = Array.isArray(order.staffAudit) ? order.staffAudit : [];
      order.staffAudit.unshift({
        id: "OA" + Date.now().toString(36).toUpperCase(),
        staffId: actor.staffId,
        staffUsername: actor.staffUsername,
        label: adminActorLabel(actor),
        action: target ? (body.action === "claim" ? "claim" : "assign") : "unassign",
        assignedStaffId: Number(target?.id || 0),
        assignedStaffUsername: target?.username || "",
        status: order.status,
        createdAt: now.toISOString(),
        createdAtBeijing: formatBeijingTime(now),
      });
      order.staffAudit = order.staffAudit.slice(0, 30);
      const assignmentAction = target ? (body.action === "claim" ? "order_claim" : "order_assign") : "order_unassign";
      const assignmentEffect = {
        action: assignmentAction,
        previousStaffId,
        assignedStaffId: Number(target?.id || 0),
        assignedStaffUsername: target?.username || "",
      };
      order.processedMutations = [
        {
          id: mutationId,
          hash: mutationHash,
          principal: operationPrincipal,
          revision: expectedRevision + 1,
          createdAt: now.toISOString(),
          effects: { assignment: assignmentEffect },
        },
        ...processedMutations.filter((item) => item?.id !== mutationId || item?.principal !== operationPrincipal),
      ].slice(0, 100);

      const saved = await setOrderAt(entry.index, order, { expectedRevision });
      if (!saved) return Response.json({ ok: false, error: "stale_revision", mutationApplied: false }, { status: 409 });
      const timelineOk = await appendOrderTimelineOnce(order.orderId, `${operation.operationId}:assignment-timeline`, {
        type: target ? "assigned" : "unassigned",
        visibility: "internal",
        summaryZh: target ? `负责人已更新为 ${target.username}` : "已取消订单负责人",
        summaryEn: target ? `Assigned to ${target.username}` : "Order unassigned",
        actor: actor.staffUsername,
      });
      const logOk = await pushAdminActionLog({
        action: assignmentAction,
        actor,
        target: "order:" + canonicalOrderId,
        detail: assignmentEffect,
        operationId: `${operation.operationId}:assignment-admin-log`,
      });
      if (!timelineOk || !logOk) {
        return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });
      }
      const responsePayload = {
        ok: true,
        order: orderForAdminResponse(order),
        assignment: {
          staffId: Number(order.assignedStaffId || 0),
          username: order.assignedStaffUsername || "",
          assignedAt: order.assignedAt || "",
          assignedAtBeijing: order.assignedAtBeijing || "",
        },
      };
      const completed = await completeDurableOperation(operation, responsePayload);
      if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
      return Response.json(responsePayload);
    } finally {
      const releaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
      await redisCmd(["EVAL", releaseScript, "1", lockKey, lockToken]);
    }
  }

  // Serialize the full read/effect/write sequence for a single order. Balance
  // effects below also carry their own permanent idempotency key, so a worker
  // dying after an effect cannot make a retried request pay/refund twice.
  const updateLockKey = `lm:order:update-lock:${canonicalOrderId}`;
  const updateLockToken = randomBytes(16).toString("hex");
  const updateLocked = await redisCmd(["SET", updateLockKey, updateLockToken, "NX", "EX", "120"]);
  if (updateLocked !== "OK") {
    return Response.json({ ok: false, error: "order_update_busy" }, { status: 409 });
  }

  try {

  const ALLOWED_STATUS = ["awaiting_quote", "pending_payment", "quote_expired", "received", "completed", "invalid"];
  let newStatus = ALLOWED_STATUS.includes(body.status) ? body.status : null;
  const quoteRequested = Object.prototype.hasOwnProperty.call(body, "quoteAmount");
  const staffNotes = clean(body.staffNotes, 1500);
  const internalNotes = clean(body.internalNotes, 2000);
  const internalReference = normalizeInternalReference(body.internalReference);
  const deliveryMessageMode = ["auto", "custom"].includes(body.deliveryMessageMode)
    ? body.deliveryMessageMode
    : null;
  const itemUpdates = Array.isArray(body.items) ? body.items : [];

  let currentEntry = await getOrderEntryById(canonicalOrderId);
  if (!currentEntry?.order || currentEntry.order.deleted) {
    return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  }
  if (currentEntry.order.pendingTransition) {
    const resumed = await resumePendingOrderTransition(currentEntry);
    if (!resumed.ok) {
      return Response.json({ ok: false, error: resumed.error || "order_transition_pending" }, {
        status: resumed.error === "out_of_stock" ? 409 : 503,
      });
    }
    currentEntry = await getOrderEntryById(canonicalOrderId);
    if (!currentEntry?.order) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  }
  const index = currentEntry.index;
  const originalOrder = currentEntry.order;
  let order = JSON.parse(JSON.stringify(originalOrder));
  if ((!Array.isArray(order.items) || order.items.length === 0)
    && itemUpdates.some((update) => Number(update?.index) === 0)) {
    // Legacy orders stored credentials only at the top level. Materialize the
    // synthetic item inside this same optimistic CAS before applying index 0.
    order.items = [legacyOrderItem(order)];
  }
  const currentRevision = Math.max(0, Number(order.revision || 0));
  const currentNetflixDeliveryMode = ["self_service", "password"].includes(order.netflixDeliveryMode)
    ? order.netflixDeliveryMode
    : "";
  const hasNetflixDeliveryMode = Object.prototype.hasOwnProperty.call(body, "netflixDeliveryMode");
  const nextNetflixDeliveryMode = hasNetflixDeliveryMode
    ? clean(body.netflixDeliveryMode, 20)
    : currentNetflixDeliveryMode;
  if (hasNetflixDeliveryMode && !["self_service", "password"].includes(nextNetflixDeliveryMode)) {
    return Response.json({ ok: false, error: "invalid_netflix_delivery_mode" }, { status: 400 });
  }
  const enteringCompleted = newStatus === "completed" && order.status !== "completed";
  const changingCompletedNetflixMode = order.status === "completed"
    && hasNetflixDeliveryMode
    && nextNetflixDeliveryMode !== currentNetflixDeliveryMode;
  const changingCompletedCredentials = order.status === "completed"
    && completionCredentialsChanged(order, itemUpdates);
  const nextNetflixOperationallyEnabled = typeof body.netflixSelfServiceEnabled === "boolean"
    ? body.netflixSelfServiceEnabled
    : order.netflixSelfServiceEnabled !== false;
  const enablingCompletedOperational = order.status === "completed"
    && body.netflixSelfServiceEnabled === true
    && order.netflixSelfServiceEnabled === false
    && nextNetflixDeliveryMode !== "password";
  const enteringOrChangingExclusiveSelfService = (enteringCompleted || changingCompletedNetflixMode)
    && nextNetflixDeliveryMode === "self_service";
  if (enteringOrChangingExclusiveSelfService && !nextNetflixOperationallyEnabled) {
    return Response.json({ ok: false, error: "completion_netflix_self_service_paused" }, { status: 409 });
  }
  if (enteringOrChangingExclusiveSelfService || enablingCompletedOperational) {
    const netflixUserState = await netflixUserSelfServiceState(order);
    if (!netflixUserState.ok) {
      return Response.json({ ok: false, error: "completion_netflix_user_state_unavailable" }, { status: 503 });
    }
    if (netflixUserState.disabled) {
      return Response.json({ ok: false, error: "completion_netflix_user_self_service_paused" }, { status: 409 });
    }
  }
  if (enteringCompleted || changingCompletedNetflixMode || changingCompletedCredentials || enablingCompletedOperational) {
    const missing = missingCompletionCredential(order, itemUpdates, nextNetflixDeliveryMode === "self_service");
    if (missing) {
      return Response.json({
        ok: false,
        error: missing.reason === "netflix_email_required"
          ? "completion_netflix_email_required"
          : missing.reason === "netflix_account_conflict"
            ? "completion_netflix_account_conflict"
            : "completion_credentials_required",
        itemIndex: missing.index,
        itemLabel: missing.label,
      }, { status: 400 });
    }
  }
  const operation = await claimDurableOperation({
    scope: "admin-order-patch",
    principal: operationPrincipal,
    idempotencyKey: mutationId,
    requestHash: mutationHash,
  });
  if (!operation.ok) {
    return Response.json({ ok: false, error: operation.error }, {
      status: operation.error === "idempotency_conflict" ? 409 : 503,
    });
  }
  if (operation.state === "done") {
    return Response.json({
      ...(operation.record.result || { ok: true }),
      order: orderForAdminResponse(order),
      idempotent: true,
    });
  }
  const processedMutations = Array.isArray(order.processedMutations) ? order.processedMutations : [];
  const priorMutation = processedMutations.find((item) => (
    item?.id === mutationId && (!item.principal || item.principal === operationPrincipal)
  ));
  if (priorMutation) {
    if (priorMutation.hash !== mutationHash) {
      return Response.json({ ok: false, error: "idempotency_conflict" }, { status: 409 });
    }
    const replayedDeliveries = {};
    if (body.action === "spotify_password_error") {
      const itemIndex = Number(body.itemIndex);
      const item = Number.isInteger(itemIndex) ? order.items?.[itemIndex] : null;
      const token = mutationLinkToken("spotify-correction-link", order.orderId, mutationId, mutationHash, itemIndex);
      if (item?.service === "spotify"
        && item.passwordCorrectionTokenHash === createHash("sha256").update(token).digest("hex")
        && validEmail(order.email)) {
        const settings = await getSettings();
        const brandName = settings.brand.name || BRAND_NAME;
        const updateUrl = `${SITE_URL}/order-update/spotify/${encodeURIComponent(order.orderId)}#token=${encodeURIComponent(token)}`;
        const email = buildSpotifyPasswordErrorEmail({
          order, item, updateUrl, brandName, siteDomain: SITE_DOMAIN,
          staffNote: item.passwordCorrectionStaffNote || "",
        });
        replayedDeliveries.spotify = await deliverEmailOnce(
          `admin-order:${order.orderId}:operation:${operation.operationId}:spotify-email`,
          () => sendSimpleEmail({
            to: order.email, ...email,
            idempotencyKey: `spotify-password-error:${order.orderId}:${operation.operationId}`,
            category: "password_update",
            relatedType: "order",
            relatedId: order.orderId,
            fromName: brandName, support: settings.support,
            locale: order.locale === "en" ? "en" : "zh",
          }),
        );
      }
    }
    if (newStatus === "completed" && order.status === "completed") {
      replayedDeliveries.completion = await deliverEmailOnce(
        `admin-order:${order.orderId}:operation:${operation.operationId}:completed-email`,
        () => sendCompletionEmail(order),
      );
    }
    if (newStatus === "invalid" && order.status === "invalid") {
      replayedDeliveries.invalid = await deliverEmailOnce(
        `admin-order:${order.orderId}:operation:${operation.operationId}:invalid-email`,
        () => sendInvalidOrderEmail(order),
      );
    }
    if (quoteRequested && order.status === "pending_payment") {
      const token = mutationLinkToken("quote-payment-link", order.orderId, mutationId, mutationHash);
      if (order.quotePaymentTokenHash === createHash("sha256").update(token).digest("hex")) {
        const quotePaymentUrl = `${SITE_URL}/checkout/quote/${encodeURIComponent(order.orderId)}#token=${encodeURIComponent(token)}`;
        replayedDeliveries.quote = await deliverEmailOnce(
          `admin-order:${order.orderId}:operation:${operation.operationId}:quote-email`,
          () => sendProxyQuoteEmail(order, quotePaymentUrl),
        );
      }
    }
    const effects = priorMutation.effects || {};
    let internalEffectsOk = true;
    if (effects.referenceChanged) {
      internalEffectsOk = await appendOrderTimelineOnce(order.orderId, `${operation.operationId}:reference-timeline`, {
        type: "reference_changed",
        visibility: "internal",
        summaryZh: order.internalReference ? `内部编号已设为 ${order.internalReference}` : "内部编号已清除",
        summaryEn: order.internalReference ? `Internal reference set to ${order.internalReference}` : "Internal reference cleared",
        actor: actor.staffUsername,
      }) && internalEffectsOk;
    }
    if (effects.credentialsChanged) {
      internalEffectsOk = await appendOrderTimelineOnce(order.orderId, `${operation.operationId}:credentials-timeline`, {
        type: "credentials_updated",
        visibility: "public",
        summaryZh: "服务登录资料已更新",
        summaryEn: "Service login details updated",
        actor: actor.staffUsername,
      }) && internalEffectsOk;
    }
    if (effects.statusChanged) {
      const statusCopy = {
        awaiting_quote: ["订单等待报价", "Order awaiting quote"],
        pending_payment: ["订单等待付款", "Order awaiting payment"],
        quote_expired: ["报价已失效", "Quote expired"],
        received: ["订单已收到", "Order received"],
        completed: ["订单已完成", "Order completed"],
        invalid: ["订单已标记无效", "Order marked invalid"],
      }[order.status] || ["订单状态已更新", "Order status updated"];
      internalEffectsOk = await appendOrderTimelineOnce(order.orderId, `${operation.operationId}:status-timeline`, {
        type: `status_${order.status}`,
        visibility: "public",
        summaryZh: statusCopy[0],
        summaryEn: statusCopy[1],
        actor: actor.staffUsername,
        meta: { status: order.status },
      }) && internalEffectsOk;
    }
    const pushResults = await enqueueOrderUpdatePush(order, effects, operation.operationId);
    if (effects.statusChanged) {
      await traceAdminOrderBestEffort(order, {
        stage: "admin_order_status_update",
        component: "admin_order",
        outcome: "ok",
        operationId: operation.operationId,
      });
    }
    await traceAdminOrderBestEffort(order, {
      stage: "push_enqueue_order",
      component: "push",
      outcome: pushResults.some((item) => item?.ok === false) ? "error" : pushResults.length ? "ok" : "skipped",
      operationId: operation.operationId,
      errorCode: pushResults.find((item) => item?.ok === false)?.error || "",
    });
    const logOk = await pushAdminActionLog({
      action: effects.adminAction || (body.action === "spotify_password_error" ? "spotify_password_error" : "order_update"),
      actor,
      target: "order:" + canonicalOrderId,
      detail: effects.adminDetail || { status: newStatus || order.status },
      operationId: `${operation.operationId}:admin-log`,
    });
    if (!internalEffectsOk || !logOk) {
      return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });
    }
    const replayPayload = { ok: true, order: orderForAdminResponse(order), replayedDeliveries };
    const completed = await completeDurableOperation(operation, replayPayload);
    if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
    return Response.json({ ...replayPayload, idempotent: true });
  }
  // A lost response is retried with the revision from the original request.
  // Check the durable mutation record first; only new operations participate
  // in optimistic concurrency control.
  if (body.expectedRevision != null && Number(body.expectedRevision) !== currentRevision) {
    return Response.json({
      ok: false,
      error: "stale_revision",
      mutationApplied: false,
      currentRevision,
      order: orderForAdminResponse(order),
    }, { status: 409 });
  }
  const previousStatus = order.status;
  const previousReference = normalizeInternalReference(order.internalReference);
  const previousCredentials = JSON.stringify((order.items || []).map((item) => ({
    account: item?.account || "",
    password: item?.password || "",
    staffAccount: item?.staffAccount || "",
    staffPassword: item?.staffPassword || "",
  })));

  if (body.action === "spotify_password_error") {
    if (order.status === "invalid") {
      return Response.json({ ok: false, error: "order_invalid" }, { status: 409 });
    }
    const itemIndex = Number(body.itemIndex);
    const item = Number.isInteger(itemIndex) ? order.items?.[itemIndex] : null;
    if (!item || item.service !== "spotify") {
      return Response.json({ ok: false, error: "spotify_item_not_found" }, { status: 404 });
    }
    if (!validEmail(order.email)) {
      return Response.json({ ok: false, error: "order_email_missing" }, { status: 409 });
    }

    const now = new Date();
    const passwordCorrectionStaffNote = clean(body.staffNote, 500);
    const token = mutationLinkToken("spotify-correction-link", order.orderId, mutationId, mutationHash, itemIndex);
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    item.passwordCorrectionTokenHash = createHash("sha256").update(token).digest("hex");
    delete item.passwordCorrectionResolvedTokenHash;
    delete item.passwordCorrectionResolvedTokenExpiresAt;
    delete item.passwordCorrectionResolvedOperationId;
    item.passwordCorrectionRequestedAt = now.toISOString();
    item.passwordCorrectionRequestedAtBeijing = formatBeijingTime(now);
    item.passwordCorrectionExpiresAt = expiresAt.toISOString();
    item.passwordCorrectionRequestVersion = Number(item.passwordCorrectionRequestVersion || 0) + 1;
    item.passwordCorrectionStaffNote = passwordCorrectionStaffNote;

    order.revision = currentRevision + 1;
    order.processedMutations = [
      {
        id: mutationId,
        hash: mutationHash,
        principal: operationPrincipal,
        revision: order.revision,
        createdAt: now.toISOString(),
        effects: {
          adminAction: "spotify_password_error",
          adminDetail: { itemIndex },
        },
      },
      ...processedMutations.filter((entry) => entry?.id !== mutationId || entry?.principal !== operationPrincipal),
    ].slice(0, 100);

    const saved = await setOrderAt(index, order, { expectedRevision: currentRevision });
    if (!saved) return Response.json({ ok: false, error: "stale_revision", mutationApplied: false }, { status: 409 });

    const settings = await getSettings();
    const brandName = settings.brand.name || BRAND_NAME;
    const updateUrl = `${SITE_URL}/order-update/spotify/${encodeURIComponent(order.orderId)}#token=${encodeURIComponent(token)}`;
    const email = buildSpotifyPasswordErrorEmail({
      order,
      item,
      updateUrl,
      brandName,
      siteDomain: SITE_DOMAIN,
      staffNote: passwordCorrectionStaffNote,
    });
    const emailResult = await deliverEmailOnce(
      `admin-order:${order.orderId}:operation:${operation.operationId}:spotify-email`,
      () => sendSimpleEmail({
        to: order.email,
        ...email,
        idempotencyKey: `spotify-password-error:${order.orderId}:${operation.operationId}`,
        category: "password_update",
        relatedType: "order",
        relatedId: order.orderId,
        fromName: brandName,
        support: settings.support,
        locale: order.locale === "en" ? "en" : "zh",
      }),
    );
    const emailedAt = new Date();
    item.passwordCorrectionEmailHandledAt = emailedAt.toISOString();
    item.passwordCorrectionEmailSuppressed = Boolean(emailResult?.suppressed);
    if (emailResult?.delivered) {
      item.passwordCorrectionEmailSentAt = emailedAt.toISOString();
      item.passwordCorrectionEmailSentAtBeijing = formatBeijingTime(emailedAt);
    }
    item.passwordCorrectionEmailOk = Boolean(emailResult?.delivered);
    item.passwordCorrectionEmailError = emailResult?.delivered
      ? ""
      : clean(emailResult?.reason || emailResult?.error || (emailResult?.suppressed ? "suppressed" : "send_failed"), 120);

    order.staffAudit = Array.isArray(order.staffAudit) ? order.staffAudit : [];
    order.staffAudit.unshift({
      id: "OA" + Date.now().toString(36).toUpperCase(),
      staffId: actor.staffId,
      staffUsername: actor.staffUsername,
      label: adminActorLabel(actor),
      action: "spotify_password_error",
      status: order.status,
      createdAt: emailedAt.toISOString(),
      createdAtBeijing: formatBeijingTime(emailedAt),
    });
    order.staffAudit = order.staffAudit.slice(0, 30);
    const metadataExpectedRevision = Number(order.revision);
    const metadataSaved = await setOrderAt(index, order, { expectedRevision: metadataExpectedRevision });
    if (!metadataSaved) {
      const latestEntry = await getOrderEntryById(canonicalOrderId);
      return Response.json({
        ok: false,
        error: "stale_revision",
        mutationApplied: true,
        order: latestEntry?.order ? orderForAdminResponse(latestEntry.order) : null,
        passwordCorrection: { itemIndex, expiresAt: item.passwordCorrectionExpiresAt, email: emailResult },
      }, { status: 409 });
    }
    const logOk = await pushAdminActionLog({
      action: "spotify_password_error",
      actor,
      target: "order:" + canonicalOrderId,
      detail: { itemIndex, emailOk: Boolean(emailResult?.delivered), suppressed: Boolean(emailResult?.suppressed) },
      operationId: `${operation.operationId}:admin-log`,
    });
    if (!logOk) return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });

    const responsePayload = {
      ok: true,
      order: orderForAdminResponse(order),
      passwordCorrection: {
        itemIndex,
        expiresAt: item.passwordCorrectionExpiresAt,
        email: emailResult,
      },
    };
    const completed = await completeDurableOperation(operation, responsePayload);
    if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
    return Response.json(responsePayload);
  }

  if (order.orderType !== "proxy_payment" && ["awaiting_quote", "pending_payment", "quote_expired"].includes(newStatus)) {
    return Response.json({ ok: false, error: "invalid_status" }, { status: 400 });
  }
  if (order.orderType === "proxy_payment" && !quoteRequested) {
    if (order.status === "quote_expired" && newStatus === "pending_payment") {
      return Response.json({ ok: false, error: "requote_required" }, { status: 409 });
    }
    if (newStatus === "pending_payment" && (!Number(order.quoteAmount || 0) || !order.quotePaymentTokenHash)) {
      return Response.json({ ok: false, error: "quote_required" }, { status: 409 });
    }
    if (newStatus === "received" && ["awaiting_quote", "quote_expired"].includes(order.status)) {
      return Response.json({ ok: false, error: "quote_required" }, { status: 409 });
    }
    if (newStatus === "completed" && !["received", "completed"].includes(order.status)) {
      return Response.json({ ok: false, error: "payment_not_received" }, { status: 409 });
    }
  }

  let quotePaymentUrl = "";
  if (quoteRequested) {
    if (order.orderType !== "proxy_payment") {
      return Response.json({ ok: false, error: "not_proxy_order" }, { status: 400 });
    }
    if (!["awaiting_quote", "pending_payment", "quote_expired"].includes(order.status)) {
      return Response.json({ ok: false, error: "quote_status_locked" }, { status: 409 });
    }
    const quoteAmount = Math.round(Number(body.quoteAmount) * 100) / 100;
    if (!Number.isFinite(quoteAmount) || quoteAmount <= 0 || quoteAmount > 1000000) {
      return Response.json({ ok: false, error: "invalid_quote_amount" }, { status: 400 });
    }
    const now = new Date();
    const token = mutationLinkToken("quote-payment-link", order.orderId, mutationId, mutationHash);
    const quoteValidDays = normalizeQuoteValidDays(body.quoteValidDays);
    const quoteExpiresAt = new Date(now.getTime() + quoteValidDays * 24 * 60 * 60 * 1000);
    order.quoteAmount = quoteAmount;
    order.subtotal = quoteAmount;
    order.bundleFinalAmount = quoteAmount;
    order.finalAmount = quoteAmount;
    order.payableAmount = quoteAmount;
    order.paidAmount = 0;
    order.paidCurrency = "CNY";
    order.paymentMethod = "quote";
    order.quotedAt = now.toISOString();
    order.quotedAtBeijing = formatBeijingTime(now);
    order.quoteValidDays = quoteValidDays;
    order.quoteExpiresAt = quoteExpiresAt.toISOString();
    order.quoteExpiresAtBeijing = formatBeijingTime(quoteExpiresAt);
    order.quoteExpiredAt = null;
    order.quoteExpiredAtBeijing = null;
    order.quotePaymentTokenHash = createHash("sha256").update(token).digest("hex");
    order.quoteVersion = Number(order.quoteVersion || 0) + 1;
    if (order.items?.[0]) order.items[0].amount = quoteAmount;
    newStatus = "pending_payment";
    quotePaymentUrl = `${SITE_URL}/checkout/quote/${encodeURIComponent(order.orderId)}#token=${encodeURIComponent(token)}`;
  }

  // Apply item updates
  if (Array.isArray(order.items)) {
    itemUpdates.forEach((upd) => {
      const idx = Number(upd.index);
      if (Number.isFinite(idx) && order.items[idx]) {
        const it = order.items[idx];
        if (typeof upd.account === "string") it.account = clean(upd.account, 80);
        if (typeof upd.password === "string") it.password = clean(upd.password, 120);
        if (typeof upd.staffAccount === "string") it.staffAccount = clean(upd.staffAccount, 80);
        if (typeof upd.staffPassword === "string") it.staffPassword = clean(upd.staffPassword, 120);
        if (upd.fulfillment && typeof upd.fulfillment === "object") {
          it.fulfillment = normalizeFulfillment(orderItemService(order, it, idx), upd.fulfillment, it);
        }
        const service = orderItemService(order, it, idx);
        if (service === "spotify") {
          // Spotify uses the buyer credential fields in the admin editor. Old
          // staff overrides would otherwise hide a newer account or password.
          it.staffAccount = "";
          it.staffPassword = "";
        }
        // Refresh subscription links if rocket
        if (service === "rocket") {
          const u = it.staffAccount || it.account;
          if (u) it.subscriptionLinks = subscriptionLinks(u);
        }
      }
    });
  }

  if (typeof body.staffNotes === "string") order.staffNotes = staffNotes;
  if (typeof body.internalNotes === "string") order.internalNotes = internalNotes;
  if (Object.prototype.hasOwnProperty.call(body, "internalReference")) order.internalReference = internalReference;
  if (typeof body.netflixSelfServiceEnabled === "boolean") {
    order.netflixSelfServiceEnabled = body.netflixSelfServiceEnabled;
  }
  if (hasNetflixDeliveryMode) order.netflixDeliveryMode = nextNetflixDeliveryMode;
  if (typeof body.thirdPartyPlatformNotice === "boolean") {
    order.thirdPartyPlatformNotice = body.thirdPartyPlatformNotice;
  }
  if (deliveryMessageMode) order.deliveryMessageMode = deliveryMessageMode;

  // Status transition
  const wasCompleted = order.status === "completed";
  const wasInvalid = order.status === "invalid";
  let refundResult = null;
  let reclaimResult = null;
  const transitionPlan = {
    restoreStock: [], reserveStock: [], refund: false, reclaim: false,
    settleCommission: false, reverseCommission: false,
  };
  if (newStatus) {
    order.status = newStatus;
    if (newStatus === "completed" && !wasCompleted) {
      const now = new Date();
      order.completedAt = now.toISOString();
      order.completedAtBeijing = formatBeijingTime(now);
    }
    if (newStatus !== "completed") {
      order.completedAt = null;
      order.completedAtBeijing = null;
    }
    if (newStatus === "invalid" && !wasInvalid) {
      const now = new Date();
      order.invalidAt = now.toISOString();
      order.invalidAtBeijing = formatBeijingTime(now);
      // 订单作废：返还此前占用的 AI 会员库存
      transitionPlan.restoreStock = (order.items || []).flatMap((it, itemIndex) => (
        it.stockReserved || it.aiStockReserved
          ? [{ index: itemIndex, service: it.service, plan: it.plan || it.rocketPlan }]
          : []
      ));
      // 退款闭环:余额支付退回余额、还优惠券、恢复兑换码(幂等)。
      transitionPlan.refund = Boolean(order.paidByBalance || order.couponId);
    }
    if (newStatus !== "invalid") {
      order.invalidAt = null;
      order.invalidAtBeijing = null;
    }
    // 作废 → 有效(撤销作废):回收退款 + 重新占用库存,防止「既退款又生效」资金洞。
    if (wasInvalid && newStatus !== "invalid") {
      transitionPlan.reserveStock = (order.items || []).flatMap((it, itemIndex) => (
        it.stockReservationReleased
          ? [{ index: itemIndex, service: it.service, plan: it.plan || it.rocketPlan }]
          : []
      ));
      transitionPlan.reclaim = Boolean(order.refundedAt);
    }
  }

  if (deliveryMessageMode === "auto") {
    order.staffNotes = clean(buildDeliveryMessage(
      order,
      order.items,
      Boolean(order.thirdPartyPlatformNotice),
    ), 1500);
  } else if (deliveryMessageMode === "custom" && typeof body.staffNotes === "string") {
    order.staffNotes = clean(applyThirdPartyNotice(
      order.staffNotes,
      Boolean(order.thirdPartyPlatformNotice),
      order.locale === "en" ? "en" : "zh",
    ), 1500);
  }

  const referenceChanged = previousReference !== normalizeInternalReference(order.internalReference);
  const nextCredentials = JSON.stringify((order.items || []).map((item) => ({
    account: item?.account || "",
    password: item?.password || "",
    staffAccount: item?.staffAccount || "",
    staffPassword: item?.staffPassword || "",
  })));
  const credentialsChanged = previousCredentials !== nextCredentials;
  if (credentialsChanged && Array.isArray(order.items) && order.items.length > 0) {
    const primaryItem = order.items[0];
    // Order creation defines the top-level compatibility fields as a mirror of
    // items[0] even for bundles. Preserve that invariant whenever credentials
    // change; edits to later items leave the first item (and mirror) unchanged.
    order.account = primaryItem?.account || "";
    order.password = primaryItem?.password || "";
    order.staffAccount = primaryItem?.staffAccount || "";
    order.staffPassword = primaryItem?.staffPassword || "";
  }
  const statusChanged = Boolean(newStatus && previousStatus !== order.status);

  order.staffAudit = Array.isArray(order.staffAudit) ? order.staffAudit : [];
  order.staffAudit.unshift({
    id: "OA" + Date.now().toString(36).toUpperCase(),
    staffId: actor.staffId,
    staffUsername: actor.staffUsername,
    label: adminActorLabel(actor),
    action: "update",
    status: newStatus || order.status,
    createdAt: new Date().toISOString(),
    createdAtBeijing: formatBeijingTime(new Date()),
  });
  order.staffAudit = order.staffAudit.slice(0, 30);
  order.revision = currentRevision + 1;
  order.processedMutations = [
    {
      id: mutationId,
      hash: mutationHash,
      principal: operationPrincipal,
      revision: order.revision,
      createdAt: new Date().toISOString(),
      effects: {
        referenceChanged,
        credentialsChanged,
        statusChanged,
        adminAction: "order_update",
        adminDetail: { status: newStatus || order.status },
      },
    },
    ...processedMutations.filter((item) => item?.id !== mutationId || item?.principal !== operationPrincipal),
  ].slice(0, 100);

  let commissionResult = null;
  if (newStatus === "completed" && !wasCompleted) {
    transitionPlan.settleCommission = true;
  } else if (wasCompleted && newStatus && newStatus !== "completed") {
    // 已完成 → 作废/未完成:回收已发返佣。
    transitionPlan.reverseCommission = true;
  }
  const hasTransitionEffects = transitionPlan.restoreStock.length > 0
    || transitionPlan.reserveStock.length > 0
    || transitionPlan.refund
    || transitionPlan.reclaim
    || transitionPlan.settleCommission
    || transitionPlan.reverseCommission;
  if (hasTransitionEffects) {
    const transitioned = await beginOrderTransition(
      { index, order: originalOrder },
      order,
      transitionPlan,
      { mutationId: operation.operationId, mutationHash, actor },
    );
    if (!transitioned.ok) {
      return Response.json({ ok: false, error: transitioned.error || "order_transition_failed", ...(transitioned.error === "stale_revision" ? { mutationApplied: false } : {}) }, {
        status: transitioned.error === "out_of_stock" || transitioned.error === "stale_revision" ? 409 : 503,
      });
    }
    order = transitioned.order;
    refundResult = transitioned.results?.refund || null;
    reclaimResult = transitioned.results?.reclaim || null;
    commissionResult = transitioned.results?.commission || null;
  } else {
    const saved = await setOrderAt(index, order, { expectedRevision: currentRevision });
    if (!saved) return Response.json({ ok: false, error: "stale_revision", mutationApplied: false }, { status: 409 });
  }
  let internalEffectsOk = true;
  if (referenceChanged) {
    internalEffectsOk = await appendOrderTimelineOnce(order.orderId, `${operation.operationId}:reference-timeline`, {
      type: "reference_changed",
      visibility: "internal",
      summaryZh: order.internalReference ? `内部编号已设为 ${order.internalReference}` : "内部编号已清除",
      summaryEn: order.internalReference ? `Internal reference set to ${order.internalReference}` : "Internal reference cleared",
      actor: actor.staffUsername,
    }) && internalEffectsOk;
  }
  if (credentialsChanged) {
    internalEffectsOk = await appendOrderTimelineOnce(order.orderId, `${operation.operationId}:credentials-timeline`, {
      type: "credentials_updated",
      visibility: "public",
      summaryZh: "服务登录资料已更新",
      summaryEn: "Service login details updated",
      actor: actor.staffUsername,
    }) && internalEffectsOk;
  }
  if (statusChanged) {
    const statusCopy = {
      awaiting_quote: ["订单等待报价", "Order awaiting quote"],
      pending_payment: ["订单等待付款", "Order awaiting payment"],
      quote_expired: ["报价已失效", "Quote expired"],
      received: ["订单已收到", "Order received"],
      completed: ["订单已完成", "Order completed"],
      invalid: ["订单已标记无效", "Order marked invalid"],
    }[order.status] || ["订单状态已更新", "Order status updated"];
    internalEffectsOk = await appendOrderTimelineOnce(order.orderId, `${operation.operationId}:status-timeline`, {
      type: `status_${order.status}`,
      visibility: "public",
      summaryZh: statusCopy[0],
      summaryEn: statusCopy[1],
      actor: actor.staffUsername,
      meta: { status: order.status },
    }) && internalEffectsOk;
  }
  const pushResults = await enqueueOrderUpdatePush(
    order,
    { credentialsChanged, statusChanged },
    operation.operationId,
  );
  if (statusChanged) {
    await traceAdminOrderBestEffort(order, {
      stage: "admin_order_status_update",
      component: "admin_order",
      outcome: "ok",
      operationId: operation.operationId,
    });
  }
  await traceAdminOrderBestEffort(order, {
    stage: "push_enqueue_order",
    component: "push",
    outcome: pushResults.some((item) => item?.ok === false) ? "error" : pushResults.length ? "ok" : "skipped",
    operationId: operation.operationId,
    errorCode: pushResults.find((item) => item?.ok === false)?.error || "",
  });
  const logOk = await pushAdminActionLog({
    action: "order_update",
    actor,
    target: "order:" + canonicalOrderId,
    detail: { status: newStatus || order.status },
    operationId: `${operation.operationId}:admin-log`,
  });
  if (!internalEffectsOk || !logOk) {
    return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });
  }

  // Send status emails only on a real transition, not on repeated saves.
  // Telegram is NOT pinged for staff changes (only initial new orders).
  let emailResult = null;
  if (newStatus === "completed" && !wasCompleted) {
    emailResult = await deliverEmailOnce(
      `admin-order:${order.orderId}:operation:${operation.operationId}:completed-email`,
      () => sendCompletionEmail(order),
    );
  }
  let invalidEmailResult = null;
  if (newStatus === "invalid" && !wasInvalid) {
    invalidEmailResult = await deliverEmailOnce(
      `admin-order:${order.orderId}:operation:${operation.operationId}:invalid-email`,
      () => sendInvalidOrderEmail(order),
    );
    const noticeAt = new Date();
    order.invalidEmailNoticeAt = noticeAt.toISOString();
    order.invalidEmailNoticeAtBeijing = formatBeijingTime(noticeAt);
    order.invalidEmailNoticeOk = Boolean(invalidEmailResult?.delivered);
    order.invalidEmailNoticeSuppressed = Boolean(invalidEmailResult?.suppressed);
    order.invalidEmailNoticeError = invalidEmailResult?.delivered ? "" : clean(invalidEmailResult?.reason || invalidEmailResult?.error || (invalidEmailResult?.suppressed ? "suppressed" : "send_failed"), 120);
    const noticeExpectedRevision = Number(order.revision);
    const noticeSaved = await setOrderAt(index, order, { expectedRevision: noticeExpectedRevision });
    if (!noticeSaved) {
      const latestEntry = await getOrderEntryById(canonicalOrderId);
      return Response.json({
        ok: false,
        error: "stale_revision",
        mutationApplied: true,
        order: latestEntry?.order ? orderForAdminResponse(latestEntry.order) : null,
        invalidNotice: { email: invalidEmailResult },
      }, { status: 409 });
    }
  }

  let quoteEmailResult = null;
  if (quotePaymentUrl) {
    quoteEmailResult = await deliverEmailOnce(
      `admin-order:${order.orderId}:operation:${operation.operationId}:quote-email`,
      () => sendProxyQuoteEmail(order, quotePaymentUrl),
    );
    const quoteHandledAt = new Date();
    order.quoteEmailHandledAt = quoteHandledAt.toISOString();
    order.quoteEmailSuppressed = Boolean(quoteEmailResult?.suppressed);
    if (quoteEmailResult?.delivered) {
      order.quoteEmailSentAt = quoteHandledAt.toISOString();
      order.quoteEmailSentAtBeijing = formatBeijingTime(quoteHandledAt);
    }
    order.quoteEmailOk = Boolean(quoteEmailResult?.delivered);
    order.quoteEmailError = quoteEmailResult?.delivered ? "" : clean(quoteEmailResult?.reason || quoteEmailResult?.error || (quoteEmailResult?.suppressed ? "suppressed" : "send_failed"), 120);
    const quoteNoticeExpectedRevision = Number(order.revision);
    const quoteNoticeSaved = await setOrderAt(index, order, { expectedRevision: quoteNoticeExpectedRevision });
    if (!quoteNoticeSaved) {
      const latestEntry = await getOrderEntryById(canonicalOrderId);
      return Response.json({
        ok: false,
        error: "stale_revision",
        mutationApplied: true,
        order: latestEntry?.order ? orderForAdminResponse(latestEntry.order) : null,
        quote: { email: quoteEmailResult },
      }, { status: 409 });
    }
  }

  const responseOrder = orderForAdminResponse(order);

  const responsePayload = {
    ok: true, order: responseOrder,
    completion: newStatus === "completed" && !wasCompleted ? { email: emailResult } : null,
    invalidNotice: newStatus === "invalid" && !wasInvalid ? { email: invalidEmailResult } : null,
    commission: commissionResult,
    refund: refundResult,
    reclaim: reclaimResult,
    quote: quotePaymentUrl ? {
      email: quoteEmailResult,
      amount: order.quoteAmount,
      validDays: order.quoteValidDays,
      expiresAt: order.quoteExpiresAt,
      expiresAtBeijing: order.quoteExpiresAtBeijing,
    } : null,
    statusChange: newStatus,
  };
  const completed = await completeDurableOperation(operation, responsePayload);
  if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
  return Response.json(responsePayload);
  } finally {
    const releaseScript = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
    await redisCmd(["EVAL", releaseScript, "1", updateLockKey, updateLockToken]);
  }
}

async function sendInvalidOrderEmail(order) {
  const emailLocale = order.locale === "en" ? "en" : "zh";
  const settings = await getSettings();
  const brandName = settings.brand.name || BRAND_NAME;
  if (order.orderType === "proxy_payment") {
    const content = buildProxyOrderEmail({
      kind: "invalid", order, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, locale: emailLocale, support: settings.support,
    });
    return sendSimpleEmail({
      to: order.email,
      idempotencyKey: `order-invalid:${order.orderId}:${order.revision || 0}`,
      ...content,
      category: "order_update",
      relatedType: "order",
      relatedId: order.orderId,
      fromName: brandName,
      support: settings.support,
      locale: emailLocale,
    });
  }
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
    idempotencyKey: `order-invalid:${order.orderId}:${order.revision || 0}`,
    subject: emailLocale === "en"
      ? `Order ${order.orderId}: payment not received, marked invalid · ${brandName}`
      : `订单 ${order.orderId} 未收到付款，已标记无效 · ${brandName}`,
    text,
    html,
    category: "order_update",
    relatedType: "order",
    relatedId: order.orderId,
    fromName: brandName,
    support: settings.support,
    locale: emailLocale,
  });
}

// DELETE /api/admin/orders/:orderId — soft-delete (tombstone in storage,
// filtered from query/account/admin lists; stays out permanently).
async function deleteOrderHandler(request, { params }) {
  const session = adminSession(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const actor = adminActorFromRequest(request);
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });

  const { orderId } = await params;
  const canonicalOrderId = normalizedOrderId(orderId);
  const requestHash = idempotencyPayloadHash({ method: "DELETE", orderId: canonicalOrderId });
  const lockKey = `lm:order:update-lock:${canonicalOrderId}`;
  const lockToken = randomBytes(16).toString("hex");
  const locked = await redisCmd(["SET", lockKey, lockToken, "NX", "EX", "120"]);
  if (locked !== "OK") return Response.json({ ok: false, error: "order_update_busy" }, { status: 409 });
  try {
  const operation = await claimDurableOperation({
    scope: "admin-order-delete",
    principal: canonicalOrderId,
    idempotencyKey: idempotency.key,
    requestHash,
  });
  if (!operation.ok) {
    return Response.json({ ok: false, error: operation.error }, {
      status: operation.error === "idempotency_conflict" ? 409 : 503,
    });
  }
  if (operation.state === "done") {
    return Response.json({ ...(operation.record.result || { ok: true, deleted: canonicalOrderId, archived: true }), idempotent: true });
  }
  const target = await getOrderEntryByIdIncludingDeleted(canonicalOrderId);
  if (!target) return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });

  if (target.order.deleted) {
    if (target.order.archiveOperationId !== operation.operationId) {
      return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
    }
    const replayPayload = { ok: true, deleted: canonicalOrderId, archived: true };
    const logOk = await pushAdminActionLog({
      action: "order_delete",
      actor,
      target: "order:" + canonicalOrderId,
      detail: { email: target.order.email || "" },
      operationId: `${operation.operationId}:admin-log`,
    });
    if (!logOk) return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });
    const completed = await completeDurableOperation(operation, replayPayload);
    if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
    return Response.json({ ...replayPayload, idempotent: true });
  }

  const eligible = orderArchiveEligibility(target.order);
  if (!eligible.ok) return Response.json({ ok: false, error: eligible.error }, { status: 409 });
  const archived = await archiveOrderAt(target.index, target.order, {
    deletedByStaffId: actor.staffId,
    deletedByStaffUsername: actor.staffUsername,
    archiveOperationId: operation.operationId,
  });
  if (!archived.ok) {
    return Response.json({ ok: false, error: archived.error || "delete_failed", ...(archived.error === "stale_revision" ? { mutationApplied: false } : {}) }, {
      status: archived.error === "stale_revision" ? 409 : 500,
    });
  }
  const logOk = await pushAdminActionLog({
    action: "order_delete",
    actor,
    target: "order:" + canonicalOrderId,
    detail: { email: target.order.email || "" },
    operationId: `${operation.operationId}:admin-log`,
  });
  if (!logOk) return Response.json({ ok: false, error: "operation_effect_journal_unavailable" }, { status: 503 });

  // Telegram is intentionally NOT pinged for staff actions (only new orders trigger it).
  const responsePayload = { ok: true, deleted: canonicalOrderId, archived: true };
  const completed = await completeDurableOperation(operation, responsePayload);
  if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
  return Response.json(responsePayload);
  } finally {
    const release = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
    await redisCmd(["EVAL", release, "1", lockKey, lockToken]);
  }
}

export const GET = withApiTelemetry("admin_orders", getOrderHandler);
export const PATCH = withApiTelemetry("admin_orders", updateOrderHandler);
export const DELETE = withApiTelemetry("admin_orders", deleteOrderHandler);
