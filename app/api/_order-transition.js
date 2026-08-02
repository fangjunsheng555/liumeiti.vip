import { createHash } from "node:crypto";
import { adjustStockBatchEffectAtomic } from "./_money.js";
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

function actorSnapshot(actor) {
  return {
    staffId: Number(actor?.staffId || 1),
    staffUsername: clean(actor?.staffUsername || "admin", 60),
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
    for (const item of plan.restoreStock) {
      if (target.items?.[item.index]) {
        target.items[item.index].stockReserved = false;
        target.items[item.index].aiStockReserved = false;
        target.items[item.index].stockReservationReleased = true;
      }
    }
    results.stockRestore = restored;
  }

  if (plan.refund) {
    const refund = await refundVoidedOrder(target, actor);
    if (!refund.ok) return { ok: false, error: refund.error || "refund_failed" };
    results.refund = refund;
  }

  if (plan.reverseCommission) {
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

  if (plan.reclaim) {
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
        results.stockReserveRollback = rolledBack;
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

  if (plan.settleCommission) {
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
  if (!current || !transition?.id || !transition.targetOrder || !transition.plan) {
    return { ok: false, error: "order_transition_missing" };
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
      return { ok: true, order: latest.order, results: effects.results, idempotent: true };
    }
    return { ok: false, error: "stale_revision" };
  }
  await removePendingIndex(current.orderId);
  return { ok: true, order: target, results: effects.results };
}

export async function beginOrderTransition(entry, targetOrder, plan, options = {}) {
  if (!entry?.order || !targetOrder || typeof targetOrder !== "object") {
    return { ok: false, error: "invalid_order_transition" };
  }
  if (entry.order.pendingTransition) return resumePendingOrderTransition(entry);

  const currentRevision = Math.max(0, Number(entry.order.revision || 0));
  const mutationId = clean(options.mutationId, 160);
  const mutationHash = clean(options.mutationHash, 80);
  const id = transitionId(entry.order.orderId, currentRevision, mutationId, mutationHash);
  const now = new Date();
  const target = copy(targetOrder);
  delete target.pendingTransition;
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
    const result = await resumePendingOrderTransition(entry);
    if (result.ok || result.aborted) completed += 1;
    else pending += 1;
  }
  return { ok: true, scanned: ids.length, completed, pending };
}
