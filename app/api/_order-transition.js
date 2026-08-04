import { createHash } from "node:crypto";
import { adjustStockBatchEffectAtomic } from "./_money.js";
import { enqueueOrderPushEvent, enqueueRestockPushEvent } from "./_push.js";
import { appendBusinessTraceEvent } from "./_observability.js";
import {
  clean,
  formatBeijingTime,
  getOrderEntryById,
  redisCmd,
  reclaimRefundOnReactivate,
  refundVoidedOrder,
  reverseOrderReferralCommission,
  setOrderAt,
  settleOrderReferralCommission,
} from "./_utils.js";

const ORDER_TRANSITION_PENDING_INDEX_KEY = "liumeiti:orders:pending-transitions:v1";
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function stockName(item) {
  return `${clean(item?.service, 40)}:${clean(item?.plan || item?.rocketPlan, 40)}`;
}

function transitionId(orderId, revision, mutationId, mutationHash) {
  return createHash("sha256")
    .update(`${orderId}\0${revision}\0${mutationId || mutationHash || "transition"}`)
    .digest("hex");
}

function canonicalOrderId(value) { return clean(value, 80).replace(/\s+/g, "").toUpperCase(); }

function plain(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validStockEffects(list, target) {
  if (list === undefined) return true;
  if (!Array.isArray(list) || (list.length && !Array.isArray(target?.items))) return false;
  const seen = new Set();
  return list.every((item) => {
    const index = Number(item?.index), service = clean(item?.service, 40), plan = clean(item?.plan || item?.rocketPlan, 40);
    const targetItem = Number.isSafeInteger(index) && index >= 0 ? target.items[index] : null;
    if (!plain(item) || !targetItem || !service || !plan || seen.has(index)
        || clean(targetItem.service, 40) !== service || clean(targetItem.plan || targetItem.rocketPlan, 40) !== plan) return false;
    seen.add(index);
    return true;
  });
}

function validTransitionPlan(plan, target) {
  if (!plain(plan) || ["refund", "reverseCommission", "reclaim", "settleCommission"].some((key) => plan[key] !== undefined && typeof plan[key] !== "boolean")) return false;
  return validStockEffects(plan.restoreStock, target) && validStockEffects(plan.reserveStock, target);
}

function validTransitionSemantics(current, transition) {
  const plan = transition.plan, from = transition.fromStatus, to = transition.targetOrder.status;
  if ((plan.refund === true || (plan.restoreStock?.length || 0) > 0) && !(from !== "invalid" && to === "invalid")) return false;
  if ((plan.reclaim === true || (plan.reserveStock?.length || 0) > 0) && !(from === "invalid" && to !== "invalid")) return false;
  if (plan.settleCommission === true && !(from !== "completed" && to === "completed")) return false;
  return !(plan.reverseCommission === true && !(from === "completed" && to !== "completed"));
}

function validPendingTransition(current, transition) {
  if (!plain(current) || !plain(transition) || !plain(transition.targetOrder) || !plain(transition.plan)) return false;
  const revision = Number(current.revision), attempts = transition.attempts === undefined ? 0 : transition.attempts, orderId = clean(current.orderId, 80);
  const mutationId = clean(transition.mutationId, 160), mutationHash = clean(transition.mutationHash, 80);
  if (!orderId || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(attempts) || attempts < 0
      || (!mutationId && !mutationHash) || transition.id !== transitionId(orderId, revision - 1 - attempts, mutationId, mutationHash)
      || clean(transition.targetOrder.orderId, 80) !== orderId
      || transition.fromStatus !== current.status) return false;
  return validTransitionPlan(transition.plan, transition.targetOrder) && validTransitionSemantics(current, transition);
}

function actorSnapshot(actor) {
  return {
    staffId: Number(actor?.staffId || 1),
    staffUsername: clean(actor?.staffUsername || "admin", 60),
  };
}

async function traceOrderBestEffort(order, event) {
  if (!order?.orderId) return;
  try {
    await appendBusinessTraceEvent(order.orderId, {
      businessTraceId: order.businessTraceId,
      ...event,
    });
  } catch {}
}

async function enqueueRestocksFromResult(result, effectId) {
  const changes = Array.isArray(result?.changes) ? result.changes : [];
  const restocked = changes.filter((change) => (
    Number(change?.before) === 0
    && Number(change?.after) > 0
    && clean(change?.service, 40)
    && clean(change?.plan, 40)
  ));
  if (!restocked.length) return { ok: true, queued: 0 };
  let queued;
  try {
    queued = await Promise.all(restocked.map((change) => enqueueRestockPushEvent(
      change.service,
      change.plan,
      effectId,
    )));
  } catch (error) {
    return { ok: false, queued: 0, error: error?.message || "push_enqueue_failed" };
  }
  return {
    ok: queued.every((item) => item?.ok === true),
    queued: queued.filter((item) => item?.queued).length,
  };
}

async function runEffects(target, transition) {
  const plan = transition.plan || {};
  const actor = transition.actor || null;
  const results = {};

  if (Array.isArray(plan.restoreStock) && plan.restoreStock.length) {
    const restored = await adjustStockBatchEffectAtomic(
      plan.restoreStock.map((item) => ({ service: item.service, plan: item.plan || item.rocketPlan, delta: 1 })),
      `order-transition:${transition.id}:stock-restore`,
    );
    if (!restored.ok) return { ok: false, error: restored.error || "stock_restore_failed" };
    const restockPush = await enqueueRestocksFromResult(restored, `order-transition:${transition.id}:stock-restore`);
    for (const item of plan.restoreStock) {
      if (target.items?.[item.index]) {
        target.items[item.index].stockReserved = false;
        target.items[item.index].aiStockReserved = false;
        target.items[item.index].stockReservationReleased = true;
      }
    }
    results.stockRestore = restored;
    results.stockRestorePush = restockPush;
  }

  if (plan.refund === true) {
    const refund = await refundVoidedOrder(target, actor);
    if (!refund.ok) return { ok: false, error: refund.error || "refund_failed" };
    results.refund = refund;
  }

  if (plan.reverseCommission === true) {
    const reversed = await reverseOrderReferralCommission(target, actor);
    if (!reversed.ok) return { ok: false, error: reversed.error || "commission_effect_failed" };
    results.commission = reversed;
  }

  if (Array.isArray(plan.reserveStock) && plan.reserveStock.length) {
    const reserved = await adjustStockBatchEffectAtomic(
      plan.reserveStock.map((item) => ({ service: item.service, plan: item.plan || item.rocketPlan, delta: -1 })),
      `order-transition:${transition.id}:stock-reserve`,
    );
    if (!reserved.ok) return { ok: false, error: reserved.error || "out_of_stock" };
    const limited = reserved.limited && typeof reserved.limited === "object" ? reserved.limited : {};
    for (const item of plan.reserveStock) {
      if (target.items?.[item.index]) {
        target.items[item.index].stockReserved = Boolean(limited[stockName(item)]);
        target.items[item.index].aiStockReserved = false;
        target.items[item.index].stockReservationReleased = false;
      }
    }
    results.stockReserve = reserved;
  }

  if (plan.reclaim === true) {
    const reclaim = await reclaimRefundOnReactivate(target, actor);
    if (!reclaim.ok) {
      // A coupon conflict happens before the refund balance is reclaimed.  If
      // stock was reserved earlier in this attempt, compensate it with its own
      // durable effect before allowing the prepared transition to be aborted.
      if (!reclaim.partial && Array.isArray(plan.reserveStock) && plan.reserveStock.length) {
        const rolledBack = await adjustStockBatchEffectAtomic(
          plan.reserveStock.map((item) => ({ service: item.service, plan: item.plan || item.rocketPlan, delta: 1 })),
          `order-transition:${transition.id}:stock-reserve-rollback`,
        );
        if (!rolledBack.ok) {
          return { ok: false, error: rolledBack.error || "stock_rollback_failed", partial: true };
        }
        const rollbackPush = await enqueueRestocksFromResult(
          rolledBack,
          `order-transition:${transition.id}:stock-reserve-rollback`,
        );
        results.stockReserveRollback = rolledBack;
        results.stockReserveRollbackPush = rollbackPush;
      }
      return {
        ok: false,
        error: reclaim.error || "refund_reclaim_failed",
        partial: Boolean(reclaim.partial),
        safeToAbort: !reclaim.partial,
      };
    }
    results.reclaim = reclaim;
  }

  if (plan.settleCommission === true) {
    const settled = await settleOrderReferralCommission(target, actor);
    if (!settled.ok) return { ok: false, error: settled.error || "commission_effect_failed" };
    results.commission = settled;
  }

  return { ok: true, results };
}

function canAbortBeforeEffects(transition, error) {
  const plan = transition?.plan || {};
  return error === "out_of_stock"
    && Array.isArray(plan.reserveStock) && plan.reserveStock.length > 0
    && !(Array.isArray(plan.restoreStock) && plan.restoreStock.length > 0)
    && !plan.refund
    && !plan.reverseCommission;
}

function retryDelayMs(attempts) {
  return Math.min(MAX_RETRY_DELAY_MS, 5_000 * (2 ** Math.min(9, Math.max(0, attempts - 1))));
}

async function removePendingIndex(orderId) {
  try { await redisCmd(["ZREM", ORDER_TRANSITION_PENDING_INDEX_KEY, clean(orderId, 80)]); } catch {}
}

async function schedulePendingRetry(entry, transition, error) {
  const current = entry?.order;
  if (!current?.pendingTransition || current.pendingTransition.id !== transition.id) return false;
  const currentRevision = Math.max(0, Number(current.revision || 0));
  const attempts = Math.max(0, Number(current.pendingTransition.attempts || 0)) + 1;
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + retryDelayMs(attempts));
  const pending = copy(current);
  pending.pendingTransition = {
    ...pending.pendingTransition,
    attempts,
    lastError: clean(error || "transition_effect_failed", 120),
    lastAttemptAt: now.toISOString(),
    lastAttemptAtBeijing: formatBeijingTime(now),
    nextAttemptAt: nextAttemptAt.toISOString(),
  };
  const saved = await setOrderAt(entry.index, pending, {
    expectedRevision: currentRevision,
    completeTransitionId: transition.id,
  });
  if (saved) {
    await redisCmd(["ZADD", ORDER_TRANSITION_PENDING_INDEX_KEY, String(nextAttemptAt.getTime()), current.orderId]);
    return true;
  }
  const latest = await getOrderEntryById(current.orderId);
  if (!latest?.order?.pendingTransition) {
    await removePendingIndex(current.orderId);
    return true;
  }
  return false;
}

async function abortPendingOrderTransition(entry, transition, error) {
  const current = entry?.order;
  if (!current?.pendingTransition || current.pendingTransition.id !== transition.id) return false;
  const currentRevision = Math.max(0, Number(current.revision || 0));
  const restored = copy(current);
  delete restored.pendingTransition;
  restored.revision = currentRevision + 1;
  const abortedAt = new Date();
  restored.transitionHistory = [
    {
      id: transition.id,
      fromStatus: transition.fromStatus,
      toStatus: transition.targetOrder?.status || "",
      outcome: "aborted",
      error,
      abortedAt: abortedAt.toISOString(),
      abortedAtBeijing: formatBeijingTime(abortedAt),
      actor: transition.actor,
    },
    ...(Array.isArray(restored.transitionHistory) ? restored.transitionHistory : []),
  ].slice(0, 30);
  const saved = await setOrderAt(entry.index, restored, {
    expectedRevision: currentRevision,
    completeTransitionId: transition.id,
  });
  if (saved) {
    await removePendingIndex(current.orderId);
    return true;
  }
  const latest = await getOrderEntryById(current.orderId);
  const alreadyAborted = Boolean(latest?.order && !latest.order.pendingTransition
    && latest.order.transitionHistory?.some((item) => item?.id === transition.id && item?.outcome === "aborted"));
  if (alreadyAborted) await removePendingIndex(current.orderId);
  return alreadyAborted;
}

export async function resumePendingOrderTransition(entry) {
  const current = entry?.order;
  const transition = current?.pendingTransition;
  if (!current || !transition) return { ok: false, error: "order_transition_missing" };
  if (!plain(entry?.index) || canonicalOrderId(entry.index.orderId) !== canonicalOrderId(current.orderId)) {
    return { ok: false, error: "invalid_order_transition", quarantined: true };
  }
  if (!validPendingTransition(current, transition)) {
    return { ok: false, error: "invalid_order_transition", quarantined: true };
  }

  const target = copy(transition.targetOrder);
  const effects = await runEffects(target, transition);
  if (!effects.ok) {
    if (effects.safeToAbort || canAbortBeforeEffects(transition, effects.error)) {
      const aborted = await abortPendingOrderTransition(entry, transition, effects.error);
      return aborted ? { ...effects, aborted: true } : { ok: false, error: "stale_revision" };
    }
    const latest = await getOrderEntryById(current.orderId);
    const retryEntry = latest?.order?.pendingTransition?.id === transition.id ? latest : entry;
    await schedulePendingRetry(retryEntry, transition, effects.error);
    return { ...effects, pending: true };
  }

  const currentRevision = Math.max(0, Number(current.revision || 0));
  target.revision = currentRevision + 1;
  delete target.pendingTransition;
  if (Array.isArray(target.processedMutations)) {
    target.processedMutations = target.processedMutations.map((item) => (
      item?.id && item.id === transition.mutationId ? { ...item, revision: target.revision } : item
    ));
  }
  const completedAt = new Date();
  target.transitionHistory = [
    {
      id: transition.id,
      fromStatus: transition.fromStatus,
      toStatus: target.status,
      completedAt: completedAt.toISOString(),
      completedAtBeijing: formatBeijingTime(completedAt),
      actor: transition.actor,
    },
    ...(Array.isArray(target.transitionHistory) ? target.transitionHistory : []),
  ].slice(0, 30);

  const saved = await setOrderAt(entry.index, target, {
    expectedRevision: currentRevision,
    completeTransitionId: transition.id,
  });
  if (!saved) {
    const latest = await getOrderEntryById(current.orderId);
    if (latest?.order && !latest.order.pendingTransition
      && Array.isArray(latest.order.transitionHistory)
      && latest.order.transitionHistory.some((item) => item?.id === transition.id)) {
      await removePendingIndex(current.orderId);
      const push = transition.fromStatus !== latest.order.status
        ? await enqueueOrderPushEvent(
          latest.order,
          `order.${latest.order.status}`,
          transition.mutationId || transition.id,
        ).catch((error) => ({ ok: false, error: error?.message || "push_enqueue_failed" }))
        : { ok: true, skipped: true };
      await traceOrderBestEffort(latest.order, {
        stage: "order_status_transition",
        component: "order_transition",
        outcome: "ok",
        operationId: transition.mutationId || transition.id,
      });
      await traceOrderBestEffort(latest.order, {
        stage: "push_enqueue_order",
        component: "push",
        outcome: push.ok === false ? "error" : push.skipped ? "skipped" : "ok",
        operationId: transition.mutationId || transition.id,
        errorCode: push.error || push.reason || "",
      });
      return { ok: true, order: latest.order, results: effects.results, push, idempotent: true };
    }
    return { ok: false, error: "stale_revision" };
  }
  await removePendingIndex(current.orderId);
  const push = transition.fromStatus !== target.status
    ? await enqueueOrderPushEvent(target, `order.${target.status}`, transition.mutationId || transition.id)
      .catch((error) => ({ ok: false, error: error?.message || "push_enqueue_failed" }))
    : { ok: true, skipped: true };
  await traceOrderBestEffort(target, {
    stage: "order_status_transition",
    component: "order_transition",
    outcome: "ok",
    operationId: transition.mutationId || transition.id,
  });
  await traceOrderBestEffort(target, {
    stage: "push_enqueue_order",
    component: "push",
    outcome: push.ok === false ? "error" : push.skipped ? "skipped" : "ok",
    operationId: transition.mutationId || transition.id,
    errorCode: push.error || push.reason || "",
  });
  return { ok: true, order: target, results: effects.results, push };
}

export async function beginOrderTransition(entry, targetOrder, plan, options = {}) {
  if (!plain(entry?.order) || !plain(targetOrder) || !validTransitionPlan(plan, targetOrder)) {
    return { ok: false, error: "invalid_order_transition" };
  }
  if (!plain(entry.index) || canonicalOrderId(entry.index.orderId) !== canonicalOrderId(entry.order.orderId)) {
    return { ok: false, error: "invalid_order_transition" };
  }
  if (entry.order.pendingTransition) return resumePendingOrderTransition(entry);

  const currentRevision = Math.max(0, Number(entry.order.revision || 0));
  if (!clean(entry.order.orderId, 80) || clean(targetOrder.orderId, 80) !== clean(entry.order.orderId, 80)
      || !Number.isSafeInteger(Number(entry.order.revision || 0))
      || typeof entry.order.status !== "string") return { ok: false, error: "invalid_order_transition" };
  const mutationId = clean(options.mutationId, 160);
  const mutationHash = clean(options.mutationHash, 80);
  const id = transitionId(entry.order.orderId, currentRevision, mutationId, mutationHash);
  const now = new Date();
  const target = copy(targetOrder);
  delete target.pendingTransition;
  if (typeof target.status !== "string" || !validTransitionSemantics(entry.order, { fromStatus: entry.order.status, targetOrder: target, plan })) {
    return { ok: false, error: "invalid_order_transition" };
  }
  const pending = {
    ...copy(entry.order),
    revision: currentRevision + 1,
    pendingTransition: {
      id,
      mutationId,
      mutationHash,
      fromStatus: entry.order.status || "",
      targetOrder: target,
      plan: copy(plan || {}),
      actor: actorSnapshot(options.actor),
      createdAt: now.toISOString(),
      createdAtBeijing: formatBeijingTime(now),
      attempts: 0,
      nextAttemptAt: now.toISOString(),
    },
  };
  // Index first: if the process exits before the prepared record is written,
  // the worker will simply remove this stale member.  The opposite ordering
  // could leave a financially partial transition undiscoverable forever.
  const indexed = await redisCmd(["ZADD", ORDER_TRANSITION_PENDING_INDEX_KEY, String(now.getTime()), entry.order.orderId]);
  if (indexed == null) return { ok: false, error: "storage_unavailable" };
  const prepared = await setOrderAt(entry.index, pending, { expectedRevision: currentRevision });
  if (!prepared) {
    const latest = await getOrderEntryById(entry.order.orderId);
    if (latest?.order?.pendingTransition?.id === id) return resumePendingOrderTransition(latest);
    if (!latest?.order?.pendingTransition) await removePendingIndex(entry.order.orderId);
    return { ok: false, error: "stale_revision" };
  }
  return resumePendingOrderTransition({ index: entry.index, order: pending });
}

export async function resumeDueOrderTransitions({ now = Date.now(), limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const ids = await redisCmd([
    "ZRANGEBYSCORE", ORDER_TRANSITION_PENDING_INDEX_KEY, "-inf", String(Number(now) || Date.now()),
    "LIMIT", "0", String(safeLimit),
  ]);
  if (!Array.isArray(ids)) return { ok: false, error: "storage_unavailable", scanned: 0, completed: 0, pending: 0 };
  let completed = 0;
  let pending = 0;
  for (const rawId of ids) {
    const orderId = clean(rawId, 80);
    if (!orderId) continue;
    const entry = await getOrderEntryById(orderId);
    if (!entry?.order?.pendingTransition) {
      await removePendingIndex(orderId);
      continue;
    }
    if (canonicalOrderId(entry.order.orderId) !== canonicalOrderId(orderId)) {
      pending += 1;
      continue;
    }
    const result = await resumePendingOrderTransition(entry);
    if (result.ok || result.aborted) completed += 1;
    else pending += 1;
  }
  return { ok: true, scanned: ids.length, completed, pending };
}
