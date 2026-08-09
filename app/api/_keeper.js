// Traffic-triggered maintenance remains a fallback for the Hobby deployment.
// The authenticated /api/cron/maintenance endpoint is the authoritative entry
// point for the external hourly scheduler. Every acquired task is now
// recorded; business exceptions are no longer silently discarded.
import { randomBytes } from "node:crypto";
import { redisCmd, redisConfig } from "./_utils.js";
import { recordHealthStatus } from "./_health.js";
import { normalizeJobResult, runObservedJob } from "./_job-runner.js";
import { sampleOperationalQueues } from "./_observability.js";

const USDT_TICK_LOCK = "lm:keeper:usdt-tick";
const USDT_TICK_INTERVAL_SEC = 120;
const RENEWAL_TICK_LOCK = "lm:keeper:renewal-tick";
const RENEWAL_TICK_INTERVAL_SEC = 6 * 60 * 60;
const QUOTE_EXPIRY_TICK_LOCK = "lm:keeper:quote-expiry-tick";
const QUOTE_EXPIRY_TICK_INTERVAL_SEC = 60;
const ORDER_TRANSITION_TICK_LOCK = "lm:keeper:order-transition-tick";
const ORDER_TRANSITION_TICK_INTERVAL_SEC = 30;
const ORDER_SLA_TICK_LOCK = "lm:keeper:order-sla-tick";
const ORDER_SLA_TICK_INTERVAL_SEC = 5 * 60;
const MARKETING_TICK_LOCK = "lm:keeper:marketing-tick";
const MARKETING_TICK_INTERVAL_SEC = 120;
const MARKETING_MAINTENANCE_RESERVE_MS = 10_000;
const AFTER_SALES_OUTBOX_TICK_LOCK = "lm:keeper:after-sales-completion-outbox";
const AFTER_SALES_OUTBOX_TICK_INTERVAL_SEC = 60;
const QUEUE_SAMPLE_TICK_LOCK = "lm:keeper:queue-sample-tick";
const QUEUE_SAMPLE_TICK_INTERVAL_SEC = 5 * 60;
const TELEGRAM_ALERT_RETRY_TICK_LOCK = "lm:keeper:telegram-alert-retry-tick";
const TELEGRAM_ALERT_RETRY_TICK_INTERVAL_SEC = 60;
const PUSH_MAINTENANCE_TICK_LOCK = "lm:keeper:push-maintenance-tick";
const PUSH_MAINTENANCE_TICK_INTERVAL_SEC = 60;

const TASK_HEALTH = {
  after_sales_outbox: ["after_sales_outbox", "售后副作用恢复"],
  order_transition: ["order_transition", "订单恢复扫描"],
  quote_expiry: ["quote_expiry", "报价到期扫描"],
  usdt_confirm: ["usdt", "USDT 自动确认"],
  renewal: ["renewal", "续费提醒扫描"],
  order_sla: ["order_sla", "订单 SLA 扫描"],
  marketing_dispatch: ["marketing_queue", "营销邮件派发"],
  telegram_alert_retry: ["telegram", "Telegram 告警重试"],
  push_maintenance: ["push", "浏览器 Push 维护"],
  queue_sampler: ["job_runner", "运行队列采样"],
};

async function acquireTick(key, intervalSec) {
  const token = randomBytes(12).toString("hex");
  const acquired = await redisCmd(["SET", key, token, "NX", "EX", String(intervalSec)]);
  if (acquired === "OK") return { acquired: true, token };
  // SET NX and a storage outage both surface as null through redisCmd. One
  // cheap read distinguishes an ordinary throttle hit from an unavailable
  // lock store so outages become visible.
  const existing = await redisCmd(["GET", key]);
  if (existing === token) return { acquired: true, token, recovered: true };
  return existing ? { acquired: false, skipped: true, reason: "throttled" } : { acquired: false, skipped: false, reason: "tick_lock_unavailable" };
}

async function releaseTick(key, token) {
  if (!key || !token) return false;
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  return Number(await redisCmd(["EVAL", script, "1", key, token])) > 0;
}

async function renewTickLease(key, token, ttlMs) {
  if (!key || !token) return false;
  const safeTtlMs = Math.max(1000, Math.round(Number(ttlMs || 0)));
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end";
  return Number(await redisCmd(["EVAL", script, "1", key, token, String(safeTtlMs)])) > 0;
}

async function recordTaskHealth(job, result) {
  result = normalizeJobResult(result);
  const [component, label] = TASK_HEALTH[job] || ["job_runner", job];
  const failed = result.ok !== true;
  const disabled = !failed && result.disabled === true;
  const metrics = {
    scanned: Number(result?.scanned || result?.checked || 0),
    processed: Number(result?.processed || result?.completed || result?.settled || result?.sent || result?.expired || result?.matched || 0),
    failed: Number(result?.failed || 0),
  };
  const saved = await recordHealthStatus(component, {
    status: disabled ? "disabled" : failed ? "error" : "ok",
    summary: disabled ? `${label}未启用` : failed ? `${label}失败` : `${label}完成`,
    error: failed ? (result?.error || `${job}_failed`) : "",
    metrics,
  });
  return Boolean(saved);
}

async function runTick({ job, lockKey, intervalSec, trigger, deadlineAt = 0, handler }) {
  const lease = await acquireTick(lockKey, intervalSec);
  if (!lease.acquired) {
    if (!lease.skipped) {
      await recordHealthStatus("job_runner", {
        status: "error",
        summary: `${TASK_HEALTH[job]?.[1] || job}无法取得节流锁`,
        error: lease.reason,
      });
      return { ok: false, skipped: true, reason: lease.reason };
    }
    return { ok: true, skipped: true, reason: lease.reason };
  }
  let observed;
  let leaseLost = false;
  let businessFinished = false;
  let businessFailed = false;
  const ttlMs = Math.max(1000, Number(intervalSec || 1) * 1000);
  const heartbeatMs = Math.max(250, Math.min(15_000, Math.floor(ttlMs / 3)));
  let renewalInFlight = Promise.resolve(true);
  const renew = () => {
    renewalInFlight = renewalInFlight.then(async () => {
      if (leaseLost) return false;
      const renewed = await renewTickLease(lockKey, lease.token, ttlMs);
      if (!renewed) leaseLost = true;
      return renewed;
    }).catch(() => {
      leaseLost = true;
      return false;
    });
    return renewalInFlight;
  };
  const leaseHeartbeat = setInterval(() => {
    renew();
  }, heartbeatMs);
  leaseHeartbeat.unref?.();
  try {
    observed = await runObservedJob(job, { trigger }, async (context) => {
      const shouldContinue = () => !leaseLost && (!deadlineAt || Date.now() < deadlineAt);
      const checkpoint = async (patch = null) => {
        if (patch) await context.heartbeat(patch);
        if (!shouldContinue()) {
          return { ok: false, reason: leaseLost ? "tick_lease_lost" : "maintenance_deadline_exceeded" };
        }
        await renew();
        return shouldContinue()
          ? { ok: true }
          : { ok: false, reason: leaseLost ? "tick_lease_lost" : "maintenance_deadline_exceeded" };
      };
      if (!shouldContinue()) {
        const stopped = {
          ok: false,
          partial: true,
          deadlineExceeded: !leaseLost,
          leaseLost,
          error: leaseLost ? "tick_lease_lost" : "maintenance_deadline_exceeded",
        };
        await recordTaskHealth(job, stopped);
        return stopped;
      }
      let result;
      try {
        result = normalizeJobResult(await handler({
          ...context,
          checkpoint,
          shouldContinue,
          deadlineAt,
          remainingMs: () => deadlineAt ? Math.max(0, deadlineAt - Date.now()) : Number.POSITIVE_INFINITY,
        }));
        businessFinished = true;
        businessFailed = result.ok !== true;
      } catch (error) {
        businessFailed = true;
        throw error;
      }
      await renewalInFlight;
      if (leaseLost || (deadlineAt && Date.now() >= deadlineAt)) {
        result = {
          ...(result && typeof result === "object" ? result : {}),
          ok: false,
          partial: true,
          leaseLost,
          deadlineExceeded: !leaseLost,
          error: leaseLost ? "tick_lease_lost" : "maintenance_deadline_exceeded",
        };
      }
      const healthSaved = await recordTaskHealth(job, result);
      if (!healthSaved) {
        return {
          ...(result && typeof result === "object" ? result : {}),
          ok: false,
          businessOk: result.ok === true,
          monitoringError: "task_health_write_failed",
          error: result.ok !== true ? (result.error || "job_failed") : "task_health_write_failed",
        };
      }
      return result;
    });
  } catch (error) {
    await releaseTick(lockKey, lease.token);
    throw error;
  } finally {
    clearInterval(leaseHeartbeat);
    await renewalInFlight;
  }
  // Successful runs retain the short throttle lease. A failed run releases it
  // with compare-delete so the next request can recover immediately without
  // deleting a newer worker's lease.
  if (businessFailed || !businessFinished || leaseLost) {
    await releaseTick(lockKey, lease.token);
  } else if (!await renewTickLease(lockKey, lease.token, ttlMs)) {
    leaseLost = true;
    observed = {
      ...(observed && typeof observed === "object" ? observed : {}),
      ok: false,
      partial: true,
      leaseLost: true,
      error: "tick_lease_lost",
    };
    await recordTaskHealth(job, observed);
  }
  return observed;
}

async function afterSalesCompletionOutboxTick(trigger, { deadlineAt = 0 } = {}) {
  return runTick({
    job: "after_sales_outbox",
    lockKey: AFTER_SALES_OUTBOX_TICK_LOCK,
    intervalSec: AFTER_SALES_OUTBOX_TICK_INTERVAL_SEC,
    trigger,
    deadlineAt,
    handler: async ({ shouldContinue }) => {
      const { getAfterSalesCompletionOutbox, getAfterSalesCreationOutbox } = await import("./after-sales/_store.js");
      const { settleAfterSalesCompletionEffects } = await import("./after-sales/_completion-effects.js");
      const { settleAfterSalesCreationEffects } = await import("./after-sales/_creation-effects.js");
      const creation = await getAfterSalesCreationOutbox(30);
      const completion = await getAfterSalesCompletionOutbox(30);
      let processed = 0;
      let failed = 0;
      for (const ticket of creation) {
        if (!shouldContinue()) return { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded", scanned: creation.length + completion.length, processed, failed };
        try {
          const result = await settleAfterSalesCreationEffects(ticket);
          if (result?.settled) processed += 1;
          else failed += 1;
        } catch { failed += 1; }
      }
      for (const ticket of completion) {
        if (!shouldContinue()) return { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded", scanned: creation.length + completion.length, processed, failed };
        try {
          const result = await settleAfterSalesCompletionEffects(ticket, ticket.completedBy || { staffId: 0, staffUsername: "keeper" });
          if (result?.settled) processed += 1;
          else failed += 1;
        } catch { failed += 1; }
      }
      return {
        ok: failed === 0,
        scanned: creation.length + completion.length,
        processed,
        failed,
        ...(failed ? { error: "after_sales_effects_pending" } : {}),
      };
    },
  });
}

async function quoteExpiryTick(trigger, { deadlineAt = 0 } = {}) {
  return runTick({
    job: "quote_expiry",
    lockKey: QUOTE_EXPIRY_TICK_LOCK,
    intervalSec: QUOTE_EXPIRY_TICK_INTERVAL_SEC,
    trigger,
    deadlineAt,
    handler: async ({ shouldContinue }) => {
      const { expireDueQuoteOrders } = await import("./_quote-expiry.js");
      return expireDueQuoteOrders({ limit: 100, shouldContinue, deadlineAt });
    },
  });
}

async function orderTransitionTick(trigger, { deadlineAt = 0 } = {}) {
  return runTick({
    job: "order_transition",
    lockKey: ORDER_TRANSITION_TICK_LOCK,
    intervalSec: ORDER_TRANSITION_TICK_INTERVAL_SEC,
    trigger,
    deadlineAt,
    handler: async ({ shouldContinue }) => {
      const { resumeDueOrderTransitions } = await import("./_order-transition.js");
      return resumeDueOrderTransitions({ limit: 50, shouldContinue, deadlineAt });
    },
  });
}

async function usdtTick(trigger, { deadlineAt = 0 } = {}) {
  return runTick({
    job: "usdt_confirm",
    lockKey: USDT_TICK_LOCK,
    intervalSec: USDT_TICK_INTERVAL_SEC,
    trigger,
    deadlineAt,
    handler: async ({ shouldContinue }) => {
      const { getSettings } = await import("./_settings.js");
      const { confirmPendingUsdtPayments } = await import("./_usdt-confirm.js");
      const settings = await getSettings();
      return confirmPendingUsdtPayments({ settings, actor: { staffId: 0, staffUsername: trigger === "cron" ? "cron" : "keeper" }, shouldContinue, deadlineAt });
    },
  });
}

async function renewalTick(trigger, { deadlineAt = 0 } = {}) {
  return runTick({
    job: "renewal",
    lockKey: RENEWAL_TICK_LOCK,
    intervalSec: RENEWAL_TICK_INTERVAL_SEC,
    trigger,
    deadlineAt,
    handler: async ({ shouldContinue }) => {
      const { sendDueRenewalReminders } = await import("./_renewal.js");
      return sendDueRenewalReminders({ shouldContinue, deadlineAt });
    },
  });
}

async function orderSlaTick(trigger, { deadlineAt = 0 } = {}) {
  return runTick({
    job: "order_sla",
    lockKey: ORDER_SLA_TICK_LOCK,
    intervalSec: ORDER_SLA_TICK_INTERVAL_SEC,
    trigger,
    deadlineAt,
    handler: async ({ shouldContinue }) => {
      const { scanOverdueOrderSla } = await import("./_order-sla.js");
      return scanOverdueOrderSla({ limit: 30, shouldContinue, deadlineAt });
    },
  });
}

async function marketingCampaignTick(trigger, { deadlineAt = 0 } = {}) {
  return runTick({
    job: "marketing_dispatch",
    lockKey: MARKETING_TICK_LOCK,
    intervalSec: MARKETING_TICK_INTERVAL_SEC,
    trigger,
    deadlineAt,
    handler: async ({ shouldContinue }) => {
      const {
        dispatchDueMarketingCampaigns,
        MARKETING_RUNTIME_BATCH_LIMIT,
        normalizeMarketingBudgetResult,
      } = await import("./_marketing-campaign-queue.js");
      const dispatchDeadlineAt = deadlineAt ? Math.max(Date.now(), deadlineAt - MARKETING_MAINTENANCE_RESERVE_MS) : 0;
      return normalizeMarketingBudgetResult(await dispatchDueMarketingCampaigns({
        limit: MARKETING_RUNTIME_BATCH_LIMIT,
        shouldContinue,
        deadlineAt: dispatchDeadlineAt,
      }));
    },
  });
}

async function telegramAlertRetryTick(trigger, { deadlineAt = 0 } = {}) {
  return runTick({
    job: "telegram_alert_retry",
    lockKey: TELEGRAM_ALERT_RETRY_TICK_LOCK,
    intervalSec: TELEGRAM_ALERT_RETRY_TICK_INTERVAL_SEC,
    trigger,
    deadlineAt,
    handler: async ({ shouldContinue }) => {
      const { drainTelegramAlertRetries } = await import("./_telegram-alerts.js");
      return drainTelegramAlertRetries({ limit: 20, shouldContinue, deadlineAt });
    },
  });
}

async function pushMaintenanceTick(trigger, { deadlineAt = 0, remainingMs = 30_000 } = {}) {
  return runTick({
    job: "push_maintenance",
    lockKey: PUSH_MAINTENANCE_TICK_LOCK,
    intervalSec: PUSH_MAINTENANCE_TICK_INTERVAL_SEC,
    trigger,
    deadlineAt,
    handler: async ({ shouldContinue, remainingMs: guardedRemainingMs }) => {
      const availableMs = deadlineAt
        ? guardedRemainingMs()
        : Math.max(0, Number(remainingMs || 0));
      if (availableMs < 6_000 || !shouldContinue()) {
        return { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded", scanned: 0, processed: 0 };
      }
      const started = Date.now();
      const {
        cleanupExpiredPushSubscriptions,
        cleanupExpiredPushProviderAlerts,
        dispatchPushOutbox,
        readPushQueueStats,
        recoverPushEnqueueFailures,
      } = await import("./_push.js");
      const runStep = async (name, fn) => {
        try { return await fn(); } catch (error) {
          return { ok: false, error: String(error?.code || error?.message || `${name}_failed`).slice(0, 160) };
        }
      };
      const recovery = await runStep("push_recovery", () => recoverPushEnqueueFailures({ limit: availableMs > 20_000 ? 100 : 20 }));
      const afterRecoveryMs = availableMs - (Date.now() - started);
      const dispatch = afterRecoveryMs >= 6_000 && shouldContinue()
        ? await runStep("push_dispatch", () => dispatchPushOutbox({ limit: 20, timeBudgetMs: Math.min(30_000, Math.max(5_000, afterRecoveryMs - 2_000)) }))
        : { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded", scanned: 0, sent: 0 };
      const afterDispatchMs = availableMs - (Date.now() - started);
      const cleanup = afterDispatchMs >= 2_000 && shouldContinue()
        ? await runStep("push_cleanup", () => cleanupExpiredPushSubscriptions({ limit: afterDispatchMs > 8_000 ? 300 : 50 }))
        : { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded", scanned: 0, removed: 0 };
      const providerAlerts = shouldContinue()
        ? await runStep("push_provider_alert_cleanup", () => cleanupExpiredPushProviderAlerts({ limit: 100 }))
        : { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded", scanned: 0, removed: 0 };
      const stats = shouldContinue()
        ? await runStep("push_stats", () => readPushQueueStats())
        : { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded" };
      const steps = [recovery, dispatch, cleanup, providerAlerts, stats];
      const failed = steps.filter((result) => result?.ok !== true).length;
      return {
        ok: failed === 0,
        scanned: Number(recovery.scanned || 0) + Number(dispatch.scanned || 0) + Number(cleanup.scanned || 0),
        processed: Number(recovery.recovered || 0) + Number(dispatch.sent || 0) + Number(cleanup.removed || 0),
        failed,
        ...(failed ? { error: "push_maintenance_partial_failure" } : {}),
        recovery,
        dispatch,
        cleanup,
        providerAlerts,
        stats,
      };
    },
  });
}

async function queueSampleTick(trigger, { deadlineAt = 0 } = {}) {
  return runTick({
    job: "queue_sampler",
    lockKey: QUEUE_SAMPLE_TICK_LOCK,
    intervalSec: QUEUE_SAMPLE_TICK_INTERVAL_SEC,
    trigger,
    deadlineAt,
    handler: async ({ shouldContinue }) => {
      if (!shouldContinue()) return { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded" };
      const [{ backfillAfterSalesCreationOutbox }, { backfillDurableOperationStartedIndex }, { backfillDeliveryStatusIndexes }, { backfillOrderCredentialMirrors }] = await Promise.all([
        import("./after-sales/_store.js"),
        import("./_durable-operation.js"),
        import("./_delivery-once.js"),
        import("./_order-credential-mirror-backfill.js"),
      ]);
      const backfillRunners = [
        () => backfillAfterSalesCreationOutbox(),
        () => backfillDurableOperationStartedIndex(),
        () => backfillDeliveryStatusIndexes(),
        () => backfillOrderCredentialMirrors({ count: 25, deadlineAt, shouldContinue }),
      ];
      for (const runBackfill of backfillRunners) {
        if (!shouldContinue()) {
          return { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded" };
        }
        const result = await runBackfill();
        if (result?.ok !== true) throw new Error(result?.error || "operational_index_backfill_failed");
      }
      if (!shouldContinue()) return { ok: false, partial: true, deadlineExceeded: true, error: "maintenance_deadline_exceeded" };
      const queues = await sampleOperationalQueues();
      let monitoringError = "";
      try {
        const { reportOperationalFailure, reportOperationalRecovery } = await import("./_incidents.js");
        for (const queue of queues) {
          const fingerprint = `queue:${queue.name}`;
          let incidentResult;
          if (queue.status === "error" || queue.status === "warning") {
            const invalidTimeIndex = queue.error === "operational_queue_score_invalid";
            incidentResult = await reportOperationalFailure({
              fingerprint,
              component: "queue",
              severity: queue.status === "error" ? "P1" : "P2",
              title: invalidTimeIndex ? `${queue.label}时间索引异常` : `${queue.label}${queue.status === "error" ? "严重" : "出现"}积压`,
              errorCode: invalidTimeIndex ? queue.error : queue.status === "error" ? "queue_backlog_critical" : "queue_backlog_warning",
              detail: { count: queue.count, dueCount: queue.dueCount, oldestAgeMs: queue.oldestAgeMs },
            });
          } else {
            incidentResult = await reportOperationalRecovery({ fingerprint, component: "queue", title: `${queue.label}积压已恢复` });
          }
          if (incidentResult?.ok !== true) {
            throw new Error(incidentResult?.error || "queue_incident_sync_failed");
          }
        }
      } catch (error) {
        monitoringError = String(error?.code || error?.message || "queue_incident_sync_failed").slice(0, 160);
        await recordHealthStatus("job_runner", {
          status: "error",
          summary: "队列采样完成，但事故状态同步失败",
          error: monitoringError,
          metrics: { queues: queues.length },
        });
      }
      return {
        ok: !monitoringError,
        scanned: queues.length,
        processed: queues.length,
        failed: monitoringError ? 1 : 0,
        ...(monitoringError ? { error: monitoringError } : {}),
        queues,
      };
    },
  });
}

export async function runMaintenanceTick({
  trigger = "traffic_fallback",
  deadlineMs = trigger === "traffic_fallback" ? 42_000 : 52_000,
} = {}) {
  if (!redisConfig()) return { ok: false, error: "redis_not_configured", jobs: [] };
  const started = Date.now();
  const safeDeadlineMs = Math.max(1_000, Number(deadlineMs || 0));
  // Keep a bounded tail for the final health write and the caller's incident
  // evaluation instead of starting a new business task at the platform limit.
  const deadlineAt = started + Math.max(1_000, safeDeadlineMs - 2_000);
  const jobs = [];
  const tasks = [
    afterSalesCompletionOutboxTick,
    orderTransitionTick,
    quoteExpiryTick,
    usdtTick,
    renewalTick,
    orderSlaTick,
    marketingCampaignTick,
    queueSampleTick,
    pushMaintenanceTick,
    telegramAlertRetryTick,
  ];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    if (Date.now() >= deadlineAt) {
      jobs.push({
        ok: false,
        partial: true,
        deadlineExceeded: true,
        error: "maintenance_deadline_exceeded",
        remainingTasks: tasks.length - index,
      });
      break;
    }
    try {
      const result = await task(trigger, {
        deadlineAt,
        remainingMs: Math.max(0, deadlineAt - Date.now()),
      });
      jobs.push(result);
      if (result?.deadlineExceeded || result?.leaseLost) break;
    } catch (error) {
      jobs.push({ ok: false, error: error?.message || "maintenance_task_failed" });
    }
  }
  const failed = jobs.filter((result) => result?.ok !== true).length;
  const partial = jobs.some((result) => result?.partial || result?.deadlineExceeded || result?.leaseLost);
  const healthSaved = await recordHealthStatus("job_runner", {
    status: failed ? "error" : "ok",
    summary: failed ? "维护任务存在失败" : "维护任务运行完成",
    error: failed ? (partial ? "maintenance_deadline_or_lease_failure" : "maintenance_partial_failure") : "",
    metrics: { jobs: jobs.length, failed, partial, durationMs: Date.now() - started },
  });
  const monitoringError = healthSaved ? "" : "maintenance_health_write_failed";
  return {
    ok: failed === 0 && !partial && !monitoringError,
    jobs,
    failed,
    partial,
    ...(monitoringError ? { monitoringError, error: monitoringError } : {}),
    ...(partial ? { error: "maintenance_deadline_or_lease_failure" } : {}),
    durationMs: Date.now() - started,
  };
}

export const keeperInternals = {
  MARKETING_MAINTENANCE_RESERVE_MS,
  acquireTick,
  afterSalesCompletionOutboxTick,
  queueSampleTick,
  recordTaskHealth,
  releaseTick,
  renewTickLease,
  runTick,
  pushMaintenanceTick,
  telegramAlertRetryTick,
};
