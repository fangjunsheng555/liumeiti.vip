function parseObject(raw) {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function executeDurableOperationEval(command, state) {
  if (!Array.isArray(command) || String(command[0] || "").toUpperCase() !== "EVAL") {
    return { handled: false, result: null };
  }
  const script = String(command[1] || "");
  if (!script.includes("durable_claim_v2_lossless")
    && !script.includes("durable_complete_v2_lossless")
    && !script.includes("durable_plan_v2_lossless")) {
    return { handled: false, result: null };
  }
  const keyCount = Number(command[2] || 0);
  const keys = command.slice(3, 3 + keyCount);
  const argv = command.slice(3 + keyCount);
  const values = state.values;
  const sorted = (key) => state.sortedSet(key);

  if (script.includes("durable_claim_v2_lossless")) {
    if (keys[0] !== `liumeiti:durable-operation:v1:${argv[1]}`) return { handled: true, result: ["error", "invalid_operation_record"] };
    const raw = values.get(keys[0]);
    if (raw != null) {
      const record = parseObject(raw);
      if (!record || typeof record.requestHash !== "string") return { handled: true, result: ["error", "operation_record_corrupt"] };
      if (record.operationId !== argv[1]) return { handled: true, result: ["error", "operation_record_corrupt"] };
      if (record.requestHash !== argv[0]) return { handled: true, result: ["error", "idempotency_conflict"] };
      const operationState = String(record.state || "started");
      if ((operationState !== "started" && operationState !== "done")
        || (operationState === "done" && (!record.result || typeof record.result !== "object" || Array.isArray(record.result) || typeof record.result.ok !== "boolean"))) {
        sorted(keys[1]).set(argv[1], Number(argv[3]));
        return { handled: true, result: ["error", "operation_record_corrupt"] };
      }
      if (operationState === "done") sorted(keys[1]).delete(argv[1]);
      else {
        const storedScore = Number(record.startedAtMs);
        const score = Number.isFinite(storedScore) && storedScore >= 0 ? storedScore : Number(argv[3]);
        sorted(keys[1]).set(argv[1], score);
      }
      return { handled: true, result: ["ok", operationState, raw, "0"] };
    }
    const created = parseObject(argv[4]);
    if (!created || created.requestHash !== argv[0] || created.operationId !== argv[1] || created.state !== "started") {
      return { handled: true, result: ["error", "invalid_operation_record"] };
    }
    values.set(keys[0], argv[4]);
    sorted(keys[1]).set(argv[1], Number(argv[3]));
    return { handled: true, result: ["ok", "started", argv[4], "1"] };
  }

  const raw = values.get(keys[0]);
  const record = parseObject(raw);
  if (!record) return { handled: true, result: ["error", "operation_record_missing"] };
  if (record.requestHash !== argv[0]) return { handled: true, result: ["error", "idempotency_conflict"] };

  if (script.includes("durable_complete_v2_lossless")) {
    if (keys[0] !== `liumeiti:durable-operation:v1:${argv[2]}`) return { handled: true, result: ["error", "invalid_operation_record"] };
    if (record.operationId !== argv[2]) return { handled: true, result: ["error", "operation_record_corrupt"] };
    if (record.state === "done" && record.result && typeof record.result === "object"
      && !Array.isArray(record.result) && typeof record.result.ok === "boolean") {
      sorted(keys[1]).delete(argv[2]);
      return { handled: true, result: ["done", raw, "1"] };
    }
    if (raw !== argv[1]) return { handled: true, result: ["stale", raw] };
    const replacement = parseObject(argv[3]);
    if (!replacement || replacement.requestHash !== argv[0] || replacement.operationId !== argv[2] || replacement.state !== "done"
      || !replacement.result || typeof replacement.result !== "object" || Array.isArray(replacement.result)
      || typeof replacement.result.ok !== "boolean") {
      return { handled: true, result: ["error", "invalid_operation_result"] };
    }
    values.set(keys[0], argv[3]);
    sorted(keys[1]).delete(argv[2]);
    return { handled: true, result: ["done", argv[3], "0"] };
  }

  if (keys[0] !== `liumeiti:durable-operation:v1:${argv[1]}`) return { handled: true, result: ["error", "invalid_operation_record"] };
  if (record.operationId !== argv[1]) return { handled: true, result: ["error", "operation_record_corrupt"] };
  if (Object.hasOwn(record, "plan")) {
    return { handled: true, result: ["planned", raw, "0"] };
  }
  if (raw !== argv[2]) return { handled: true, result: ["stale", raw] };
  const replacement = parseObject(argv[3]);
  if (!replacement || replacement.requestHash !== argv[0] || replacement.operationId !== argv[1] || replacement.plan == null) {
    return { handled: true, result: ["error", "invalid_operation_plan"] };
  }
  values.set(keys[0], argv[3]);
  return { handled: true, result: ["planned", argv[3], "1"] };
}
