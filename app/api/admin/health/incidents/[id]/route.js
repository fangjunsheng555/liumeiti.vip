import { randomBytes } from "node:crypto";
import {
  adminActorFromSession,
  adminSessionFromRequest,
  clean,
  isRootAdminSession,
  listAssignableAdminStaffStrict,
  pushAdminActionLog,
  redisCmd,
  redisPipeline,
} from "../../../../_utils.js";
import { getIncident, incidentEvents, transitionIncident } from "../../../../_incidents.js";
import { withApiTelemetry } from "../../../../_observability.js";
import { claimDurableOperation, completeDurableOperation } from "../../../../_durable-operation.js";
import { idempotencyPayloadHash, requiredIdempotencyKey } from "../../../../_money.js";

export const runtime = "nodejs";

function gate(request) {
  const session = adminSessionFromRequest(request);
  return session && isRootAdminSession(session) ? session : null;
}

function completedOperationResponse(operation) {
  const stored = operation?.record?.result || { ok: true };
  const { httpStatus = 200, ...payload } = stored;
  return Response.json({ ...payload, idempotent: true }, { status: Number(httpStatus || 200) });
}

async function finishOperation(operation, payload, status = 200) {
  const completed = await completeDurableOperation(operation, { ...payload, httpStatus: status });
  if (!completed.ok) return Response.json({ ok: false, error: completed.error }, { status: 503 });
  return Response.json(payload, { status });
}

function pipelineValue(entry) {
  return entry && typeof entry === "object" && Object.hasOwn(entry, "result") ? entry.result : entry;
}

async function readOperationLock(lockKey) {
  const response = await redisPipeline([["GET", lockKey], ["PING"]]);
  const rows = Array.isArray(response) ? response : Array.isArray(response?.result) ? response.result : [];
  if (!Array.isArray(rows) || rows.length !== 2 || rows.some((entry) => (
    entry && typeof entry === "object" && Object.hasOwn(entry, "error")
  ))) return { ok: false, token: "" };
  const token = pipelineValue(rows[0]);
  const pong = pipelineValue(rows[1]);
  return pong === "PONG"
    ? { ok: true, token: token == null ? "" : String(token) }
    : { ok: false, token: "" };
}

function incidentResultStatus(error) {
  if (error === "incident_not_found") return 404;
  if (["stale_version", "fingerprint_conflict"].includes(error)) return 409;
  if ([
    "storage_unavailable",
    "incident_store_unavailable",
    "incident_record_corrupt",
    "incident_events_unavailable",
  ].includes(error)) return 503;
  return 400;
}

async function getHandler(request, { params }) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  let incident;
  let events;
  try {
    incident = await getIncident(id);
    events = incident ? await incidentEvents(id) : [];
  } catch (error) {
    return Response.json({
      ok: false,
      error: String(error?.code || error?.message || "incident_store_unavailable").slice(0, 160),
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!incident) return Response.json({ ok: false, error: "incident_not_found" }, { status: 404 });
  return Response.json({ ok: true, incident, events }, { headers: { "cache-control": "no-store" } });
}

async function patchHandler(request, { params }) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  let body = {};
  try { body = await request.json(); } catch {}
  const { id: rawId } = await params;
  const id = clean(rawId, 80).toUpperCase();
  const mutation = {
    action: clean(body.action, 30).toLowerCase(),
    expectedVersion: Number(body.expectedVersion),
    ownerStaffId: Math.max(0, Number(body.ownerStaffId || 0)),
    resolution: clean(body.resolution, 1000),
  };
  const requestHash = idempotencyPayloadHash(mutation);
  let operation = await claimDurableOperation({
    scope: "admin-health-incident-transition",
    principal: id,
    idempotencyKey: idempotency.key,
    requestHash,
  });
  if (!operation.ok) {
    return Response.json({ ok: false, error: operation.error }, { status: operation.error === "idempotency_conflict" ? 409 : 503 });
  }
  if (operation.state === "done") {
    return completedOperationResponse(operation);
  }
  const operationLockKey = operation.lockKey;
  const lockToken = randomBytes(16).toString("hex");
  const locked = await redisCmd(["SET", operationLockKey, lockToken, "NX", "EX", "30"]);
  if (locked !== "OK") {
    const lock = await readOperationLock(operationLockKey);
    if (!lock.ok) {
      return Response.json({ ok: false, error: "incident_lock_store_unavailable" }, { status: 503 });
    }
    if (lock.token === lockToken) {
      // The SET committed but its response was lost. Continue while we can
      // prove this request owns the lease.
    } else {
      operation = await claimDurableOperation({
        scope: "admin-health-incident-transition",
        principal: id,
        idempotencyKey: idempotency.key,
        requestHash,
      });
      if (operation.ok && operation.state === "done") {
        return completedOperationResponse(operation);
      }
      if (!operation.ok) return Response.json({ ok: false, error: operation.error }, { status: 503 });
      if (!lock.token) {
        return Response.json({ ok: false, error: "incident_lock_store_unavailable" }, { status: 503 });
      }
      return Response.json({ ok: false, error: "incident_operation_in_progress" }, { status: 409 });
    }
  }
  let response;
  let lockedError;
  let releaseResult;
  try {
    response = await (async () => {
    // Re-read after taking the lock. A duplicate request may have completed
    // between the first durable lookup and lock acquisition.
    operation = await claimDurableOperation({
      scope: "admin-health-incident-transition",
      principal: id,
      idempotencyKey: idempotency.key,
      requestHash,
    });
    if (!operation.ok) return Response.json({ ok: false, error: operation.error }, { status: 503 });
    if (operation.state === "done") {
      return completedOperationResponse(operation);
    }
    if (mutation.action === "assign" && mutation.ownerStaffId > 0) {
      let staff;
      try {
        staff = (await listAssignableAdminStaffStrict()).find((item) => Number(item.id) === Number(body.ownerStaffId));
      } catch (error) {
        return Response.json({
          ok: false,
          error: String(error?.code || error?.message || "admin_staff_store_unavailable").slice(0, 160),
        }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      if (!staff) return finishOperation(operation, { ok: false, error: "staff_not_found" }, 404);
      body.ownerStaffUsername = staff.username;
    }
    const actor = adminActorFromSession(session);
    let result;
    try {
      result = await transitionIncident(id, { ...body, action: mutation.action, operationId: operation.operationId }, actor);
    } catch (error) {
      return Response.json({
        ok: false,
        error: String(error?.code || error?.message || "incident_store_unavailable").slice(0, 160),
      }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    if (!result.ok) {
      const status = incidentResultStatus(result.error);
      if (status === 503) {
        return Response.json(result, { status, headers: { "cache-control": "no-store" } });
      }
      return finishOperation(operation, result, status);
    }
    const logged = await pushAdminActionLog({
      action: `incident_${mutation.action}`,
      actor,
      target: `incident:${result.record.id}`,
      detail: { status: result.record.status, ownerStaffId: result.record.ownerStaffId || 0 },
      operationId: `${operation.operationId}:admin-log`,
    });
    if (!logged) {
      return Response.json({ ok: false, error: "admin_action_log_unavailable" }, {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
    const payload = { ok: true, incident: result.record, idempotent: Boolean(result.idempotent) };
    return finishOperation(operation, payload, 200);
    })();
  } catch (error) {
    lockedError = error;
  } finally {
    const release = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
    releaseResult = await redisCmd(["EVAL", release, "1", operationLockKey, lockToken]);
  }
  if (Number(releaseResult) !== 1) {
    return Response.json({ ok: false, error: "incident_lock_release_failed" }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  if (lockedError) throw lockedError;
  return response;
}

export const GET = withApiTelemetry("admin_health", getHandler);
export const PATCH = withApiTelemetry("admin_health", patchHandler);
