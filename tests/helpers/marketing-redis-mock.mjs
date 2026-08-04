import { createHash } from "node:crypto";

export function installMarketingRedisMock(origin) {
  const values = new Map();
  const sets = new Map();
  const lists = new Map();
  const hashes = new Map();
  const sortedSets = new Map();
  const commands = [];
  const commandFailures = [];
  let requestCount = 0;
  const originalFetch = globalThis.fetch;

  const setFor = (key) => {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key);
  };
  const listFor = (key) => {
    if (!lists.has(key)) lists.set(key, []);
    return lists.get(key);
  };
  const hashFor = (key) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  };
  const zsetFor = (key) => {
    if (!sortedSets.has(key)) sortedSets.set(key, new Map());
    return sortedSets.get(key);
  };
  const hasKey = (key) => values.has(key) || sets.has(key) || lists.has(key) || hashes.has(key) || sortedSets.has(key);

  function execute(command) {
    const [rawName, ...args] = command;
    const name = String(rawName || "").toUpperCase();
    commands.push(name);
    const failureIndex = commandFailures.findIndex((failure) => (
      failure.name === name
      && (!failure.keyPrefix || String(args[failure.argumentIndex] || "").startsWith(failure.keyPrefix))
    ));
    if (failureIndex >= 0) {
      const [failure] = commandFailures.splice(failureIndex, 1);
      return failure.result;
    }
    if (name === "PING") return "PONG";
    if (name === "TYPE") {
      if (values.has(args[0])) return "string";
      if (sets.has(args[0])) return "set";
      if (lists.has(args[0])) return "list";
      if (hashes.has(args[0])) return "hash";
      if (sortedSets.has(args[0])) return "zset";
      return "none";
    }
    if (name === "GET") {
      if (values.has(args[0])) return values.get(args[0]);
      if ([sets, lists, hashes, sortedSets].some((map) => map.has(args[0]))) return { error: "WRONGTYPE Operation against a key holding the wrong kind of value" };
      return null;
    }
    if (name === "MGET") return args.map((key) => values.get(key) ?? null);
    if (name === "SISMEMBER") return sets.get(args[0])?.has(String(args[1])) ? 1 : 0;
    if (name === "SMISMEMBER") return args.slice(1).map((member) => sets.get(args[0])?.has(String(member)) ? 1 : 0);
    if (name === "SET") {
      const options = args.slice(2).map((item) => String(item).toUpperCase());
      if (options.includes("NX") && hasKey(args[0])) return null;
      for (const map of [sets, lists, hashes, sortedSets]) map.delete(args[0]);
      values.set(args[0], String(args[1]));
      return "OK";
    }
    if (name === "DEL") {
      let removed = 0;
      for (const key of args) {
        for (const map of [values, sets, lists, hashes, sortedSets]) if (map.delete(key)) removed += 1;
      }
      return removed;
    }
    if (name === "EXISTS") return hasKey(args[0]) ? 1 : 0;
    if (name === "EXPIRE" || name === "PEXPIRE") return hasKey(args[0]) ? 1 : 0;
    if (name === "TTL") return hasKey(args[0]) ? -1 : -2;
    if (name === "INCR" || name === "INCRBY") {
      const next = Number(values.get(args[0]) || 0) + Number(name === "INCR" ? 1 : args[1]);
      values.set(args[0], String(next));
      return next;
    }
    if (name === "SADD") {
      let added = 0;
      const target = setFor(args[0]);
      for (const item of args.slice(1).map(String)) {
        if (!target.has(item)) added += 1;
        target.add(item);
      }
      return added;
    }
    if (name === "SREM") {
      let removed = 0;
      for (const item of args.slice(1).map(String)) if (setFor(args[0]).delete(item)) removed += 1;
      return removed;
    }
    if (name === "SMEMBERS") return Array.from(setFor(args[0]));
    if (name === "SCARD") return setFor(args[0]).size;
    if (name === "LPUSH") {
      const target = listFor(args[0]);
      target.unshift(...args.slice(1).map(String));
      return target.length;
    }
    if (name === "RPUSH") {
      const target = listFor(args[0]);
      target.push(...args.slice(1).map(String));
      return target.length;
    }
    if (name === "LTRIM") {
      const target = listFor(args[0]);
      const start = Number(args[1]);
      const stop = Number(args[2]);
      lists.set(args[0], target.slice(start, stop < 0 ? undefined : stop + 1));
      return "OK";
    }
    if (name === "LRANGE") {
      const target = listFor(args[0]);
      const start = Number(args[1]);
      const stop = Number(args[2]);
      return target.slice(start, stop < 0 ? undefined : stop + 1);
    }
    if (name === "LLEN") return listFor(args[0]).length;
    if (name === "HSET") {
      const target = hashFor(args[0]);
      let added = 0;
      for (let index = 1; index + 1 < args.length; index += 2) {
        if (!target.has(String(args[index]))) added += 1;
        target.set(String(args[index]), String(args[index + 1]));
      }
      return added;
    }
    if (name === "HGET") return hashFor(args[0]).get(String(args[1])) ?? null;
    if (name === "HGETALL") return Object.fromEntries(hashFor(args[0]));
    if (name === "HMGET") return args.slice(1).map((field) => hashFor(args[0]).get(String(field)) ?? null);
    if (name === "HVALS") return Array.from(hashFor(args[0]).values());
    if (name === "HINCRBY" || name === "HINCRBYFLOAT") {
      const target = hashFor(args[0]);
      const field = String(args[1]);
      const next = Number(target.get(field) || 0) + Number(args[2] || 0);
      target.set(field, String(next));
      return String(next);
    }
    if (name === "ZADD") {
      const target = zsetFor(args[0]);
      let index = 1;
      let nx = false;
      if (String(args[index]).toUpperCase() === "NX") { nx = true; index += 1; }
      let added = 0;
      for (; index + 1 < args.length; index += 2) {
        const score = Number(args[index]);
        const member = String(args[index + 1]);
        if (nx && target.has(member)) continue;
        if (!target.has(member)) added += 1;
        target.set(member, score);
      }
      return added;
    }
    if (name === "ZREM") {
      let removed = 0;
      for (const member of args.slice(1).map(String)) if (zsetFor(args[0]).delete(member)) removed += 1;
      return removed;
    }
    if (name === "ZCARD") return zsetFor(args[0]).size;
    if (name === "ZRANGE" || name === "ZREVRANGE") {
      const start = Number(args[1]);
      const stop = Number(args[2]);
      const rows = Array.from(zsetFor(args[0]).entries()).sort((left, right) => (name === "ZREVRANGE" ? right[1] - left[1] : left[1] - right[1]));
      return rows.slice(start, stop < 0 ? undefined : stop + 1).map(([member]) => member);
    }
    if (name === "ZRANGEBYSCORE") {
      const min = String(args[1]).toLowerCase() === "-inf" ? -Infinity : Number(args[1]);
      const max = String(args[2]).toLowerCase() === "+inf" ? Infinity : Number(args[2]);
      let rows = Array.from(zsetFor(args[0]).entries()).filter(([, score]) => score >= min && score <= max).sort((left, right) => left[1] - right[1]).map(([member]) => member);
      const limit = args.findIndex((value) => String(value).toUpperCase() === "LIMIT");
      if (limit >= 0) rows = rows.slice(Number(args[limit + 1]), Number(args[limit + 1]) + Number(args[limit + 2]));
      return rows;
    }
    if (name === "SCAN") {
      const match = args.findIndex((value) => String(value).toUpperCase() === "MATCH");
      const pattern = match >= 0 ? String(args[match + 1]) : "*";
      const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
      const keys = new Set([...values.keys(), ...sets.keys(), ...lists.keys(), ...hashes.keys(), ...sortedSets.keys()]);
      return ["0", Array.from(keys).filter((key) => pattern === "*" || key.startsWith(prefix))];
    }
    if (name === "EVAL") {
      const script = String(args[0] || "");
      const keyCount = Number(args[1] || 0);
      const keys = args.slice(2, 2 + keyCount);
      const argv = args.slice(2 + keyCount);
      if (script.includes("doc.requestHash") && script.includes("return -1")) {
        const existing = values.get(keys[0]);
        if (existing) {
          let doc = null;
          try { doc = JSON.parse(existing); } catch { return -2; }
          if (String(doc.requestHash || "") !== String(argv[0] || "")) return -1;
          if (!zsetFor(keys[1]).has(String(argv[2]))) zsetFor(keys[1]).set(String(argv[2]), Number(argv[1]));
          return 0;
        }
        values.set(keys[0], String(argv[4]));
        if (!zsetFor(keys[1]).has(String(argv[2]))) zsetFor(keys[1]).set(String(argv[2]), Number(argv[1]));
        return 1;
      }
      if (script.includes("return 'acquired'") && script.includes("indexStatus('sending'")) {
        const member = String(argv[3]);
        const clearIndexes = () => {
          zsetFor(keys[1]).delete(member);
          zsetFor(keys[2]).delete(member);
          zsetFor(keys[3]).delete(member);
        };
        const raw = values.get(keys[0]);
        if (raw) {
          if (raw === "done") {
            clearIndexes();
            return "done";
          }
          let state = null;
          try { state = JSON.parse(raw); } catch {}
          if (!state || typeof state !== "object") {
            clearIndexes();
            zsetFor(keys[2]).set(member, Number(argv[2]));
            return "uncertain";
          }
          const status = String(state.status || "");
          if (status === "done") {
            clearIndexes();
            return raw;
          }
          if (status === "sending" || status === "uncertain") {
            clearIndexes();
            zsetFor(status === "sending" ? keys[1] : keys[2]).set(member, Number(state.score || argv[2]));
            return status;
          }
          if (status !== "retryable") {
            clearIndexes();
            zsetFor(keys[2]).set(member, Number(state.score || argv[2]));
            return "uncertain";
          }
        }
        values.set(keys[0], String(argv[1]));
        clearIndexes();
        zsetFor(keys[1]).set(member, Number(argv[2]));
        return "acquired";
      }
      if (script.includes("tostring(current.token or '')~=ARGV[1]") && script.includes("ARGV[3]=='sending'")) {
        const raw = values.get(keys[0]);
        if (!raw || raw === "done") return 0;
        let current = null;
        try { current = JSON.parse(raw); } catch { return 0; }
        if (String(current?.token || "") !== String(argv[0])) return 0;
        values.set(keys[0], String(argv[1]));
        const member = String(argv[4]);
        for (const key of keys.slice(1, 4)) zsetFor(key).delete(member);
        if (argv[2] === "sending") zsetFor(keys[1]).set(member, Number(argv[3]));
        if (argv[2] === "uncertain") zsetFor(keys[2]).set(member, Number(argv[3]));
        if (argv[2] === "retryable") zsetFor(keys[3]).set(member, Number(argv[3]));
        return 1;
      }
      if (script.includes("if raw=='done' then") && script.includes("redis.call('SET',KEYS[1],ARGV[3])")) {
        const raw = values.get(keys[0]);
        const member = String(argv[1]);
        if (raw === "done") {
          for (const key of keys.slice(1, 4)) zsetFor(key).delete(member);
          return 1;
        }
        let current = null;
        try { current = JSON.parse(raw || ""); } catch { return 0; }
        if (String(current?.token || "") !== String(argv[0])) return 0;
        values.set(keys[0], String(argv[2]));
        for (const key of keys.slice(1, 4)) zsetFor(key).delete(member);
        return 1;
      }
      if (script.includes("__in_flight__") && script.includes("SMEMBERS")) {
        const raw = values.get(keys[0]);
        if (!raw) return "__missing__";
        if (raw !== String(argv[2] || "")) return "__conflict__";
        const doc = JSON.parse(raw);
        if (String(doc.status || "") === String(argv[0] || "")) return raw;
        if (!String(argv[1] || "").split("|").includes(String(doc.status || ""))) return `__invalid__:${doc.status || ""}`;
        for (const jobId of setFor(keys[2])) {
          const jobRaw = values.get(String(argv[7]) + jobId);
          const job = jobRaw ? JSON.parse(jobRaw) : null;
          if (job?.status === "sending" && values.has(String(argv[8]) + jobId)) return "__in_flight__";
        }
        values.set(keys[0], String(argv[3]));
        if (!zsetFor(keys[1]).has(String(argv[6]))) zsetFor(keys[1]).set(String(argv[6]), Number(argv[5]));
        return String(argv[3]);
      }
      if (script.includes("__corrupt_patch__") && !script.includes("__in_flight__")) {
        const raw = values.get(keys[0]);
        if (!raw) return "__missing__";
        if (raw !== String(argv[2] || "")) return "__conflict__";
        let doc = null;
        try { doc = JSON.parse(raw); } catch { return "__corrupt__"; }
        const expected = String(argv[1] || "").split("|");
        if (!expected.includes(String(doc.status || ""))) return `__invalid__:${doc.status || ""}`;
        values.set(keys[0], String(argv[3]));
        if (!zsetFor(keys[1]).has(String(argv[6]))) zsetFor(keys[1]).set(String(argv[6]), Number(argv[5]));
        return String(argv[3]);
      }
      if (script.includes("local queueScore=tonumber(doc.queueScore or ARGV[1])")) {
        const existing = values.get(keys[0]);
        setFor(keys[2]).add(String(argv[1]));
        if (existing) {
          let doc = null;
          try { doc = JSON.parse(existing); } catch { return -2; }
          if (["queued", "sending"].includes(doc.status)) {
            zsetFor(keys[1]).set(String(argv[1]), Number(doc.queueScore || argv[0]));
            setFor(keys[3]).add(String(argv[1]));
          } else {
            zsetFor(keys[1]).delete(String(argv[1]));
            setFor(keys[3]).delete(String(argv[1]));
          }
          return 0;
        }
        values.set(keys[0], String(argv[4]));
        zsetFor(keys[1]).set(String(argv[1]), Number(argv[0]));
        setFor(keys[3]).add(String(argv[1]));
        return 1;
      }
      if (script.includes("__campaign_conflict__") && script.includes("responseEncoded")) {
        const raw = values.get(keys[0]);
        if (!raw) return "__missing__";
        const current = JSON.parse(raw);
        if (!String(argv[0] || "").split("|").includes(String(current.status || ""))) return `__invalid__:${current.status || ""}`;
        const campaignRaw = values.get(keys[5]);
        const campaign = campaignRaw ? JSON.parse(campaignRaw) : null;
        if (campaignRaw ? String(campaignRaw) !== String(argv[13]) : argv[13] !== "__lm_marketing_missing__") return "__campaign_conflict__";
        if (argv[8] === "sending") {
          if (!campaign) return "__campaign_missing__";
          if (!["scheduled", "sending"].includes(campaign.status)) return `__campaign_blocked__:${campaign.status}`;
        }
        values.set(keys[0], String(argv[1]));
        setFor(keys[4]).add(String(argv[7]));
        if (argv[4] === "terminal") {
          zsetFor(keys[1]).delete(String(argv[7]));
          setFor(keys[2]).delete(String(argv[7]));
          values.delete(keys[3]);
        } else if (argv[4] === "schedule") {
          zsetFor(keys[1]).set(String(argv[7]), Number(argv[5]));
          setFor(keys[2]).add(String(argv[7]));
          values.delete(keys[3]);
        } else {
          setFor(keys[2]).add(String(argv[7]));
        }
        if (argv[10] === "1") {
          values.set(keys[7], String(Number(values.get(keys[7]) || 0) + 1));
        }
        if (campaign) {
          const useFinal = argv[4] === "terminal" && setFor(keys[2]).size === 0;
          values.set(keys[5], String(useFinal ? argv[15] : argv[14]));
          if (!zsetFor(keys[6]).has(String(argv[6]))) zsetFor(keys[6]).set(String(argv[6]), Number(argv[12]));
          return String(useFinal ? argv[17] : argv[16]);
        }
        return String(argv[16]);
      }
      if (script.includes("__duplicate__") && script.includes("HINCRBYFLOAT")) {
        if (argv[0] !== "0") {
          if (values.has(keys[0])) return "__duplicate__";
          values.set(keys[0], "1");
        }
        const target = hashFor(keys[1]);
        const field = String(argv[1]);
        const next = Number(target.get(field) || 0) + Number(argv[4] || 0);
        target.set(field, String(next));
        return String(next);
      }
      if (script.includes("VERIFY_SEND_OWNERSHIP") || (script.includes("jobOk,job") && script.includes("campaignOk,campaign"))) {
        if (values.get(keys[0]) !== String(argv[0]) || values.get(keys[1]) !== String(argv[0])) return 0;
        const job = values.get(keys[2]) ? JSON.parse(values.get(keys[2])) : null;
        const campaign = values.get(keys[3]) ? JSON.parse(values.get(keys[3])) : null;
        return job?.status === "sending" && campaign?.status === "sending" ? 1 : 0;
      }
      if (script.includes("'done','EX'") && script.includes("ARGV[2]")) {
        if (values.get(keys[0]) !== String(argv[0])) return 0;
        values.set(keys[0], "done");
        return 1;
      }
      if (script.includes("return redis.call('EXPIRE',KEYS[1],ARGV[2])")) {
        return values.get(keys[0]) === String(argv[0]) ? 1 : 0;
      }
      if (script.includes("return redis.call('DEL',KEYS[1])") && script.includes("ARGV[1]")) {
        if (values.get(keys[0]) !== String(argv[0])) return 0;
        values.delete(keys[0]);
        return 1;
      }
      if (script.includes("CORRUPT_CONTACT_REPAIR_V1")) {
        const type = execute(["TYPE", keys[0]]);
        const raw = type === "string" ? values.get(keys[0]) : null;
        const expected = type === "string"
          ? createHash("sha1").update(String(raw)).digest("hex")
          : `type:${type}`;
        const member = String(argv[5]);
        const hasAll = setFor(keys[4]).has(member);
        const hasOptional = setFor(keys[3]).has(member);
        const hasMarketing = setFor(keys[2]).has(member);
        if (type === "none" ? String(argv[0]) !== "missing" || !(hasAll || hasOptional || hasMarketing)
          : (String(argv[0]) !== "type:any" && expected !== String(argv[0]))) return 0;
        const scope = hasAll ? "all" : hasOptional ? "optional" : "marketing";
        const replacementIndex = scope === "all" ? 3 : scope === "optional" ? 2 : 1;
        let replacement = null;
        try { replacement = JSON.parse(String(argv[replacementIndex])); } catch { return -3; }
        if (!replacement || typeof replacement !== "object"
            || replacement.suppression?.scope !== scope) return -3;
        const indexed = execute(["ZADD", keys[1], argv[4], member]);
        if (indexed == null || (typeof indexed === "object" && indexed?.error != null)) return indexed;
        for (const key of keys.slice(2, 5)) execute(["SREM", key, member]);
        execute(["SADD", keys[scope === "all" ? 4 : scope === "optional" ? 3 : 2], member]);
        execute(["SET", keys[0], String(argv[replacementIndex])]);
        return scope === "all" ? 3 : scope === "optional" ? 2 : 1;
      }
      if (script.includes("CONTACT_CAS_V2")) {
        const raw = values.get(keys[0]);
        let current = 0;
        if (raw) {
          try {
            const doc = JSON.parse(raw);
            if (!doc || typeof doc !== "object" || Array.isArray(doc)) return -2;
            const revision = Number(doc.revision);
            current = Number.isSafeInteger(revision) && revision >= 0 && revision < Number.MAX_SAFE_INTEGER ? revision : 0;
          } catch { return -2; }
        }
        if (current !== Number(argv[0])) return 0;
        if (script.includes("redis.call('ZADD',KEYS[2],ARGV[3],ARGV[4])")) {
          const indexed = execute(["ZADD", keys[1], argv[2], argv[3]]);
          if (indexed == null || (typeof indexed === "object" && indexed?.error != null)) return indexed;
        }
        values.set(keys[0], String(argv[1]));
        return 1;
      }
      if (script.includes("existing=redis.call('HGET',KEYS[2],ARGV[1])") && script.includes("LPUSH")) {
        const existing = hashFor(keys[1]).get(String(argv[0]));
        if (existing) {
          values.set(keys[2], String(argv[4]));
          return JSON.stringify({ ok: true, duplicate: true, event: existing });
        }
        hashFor(keys[1]).set(String(argv[0]), String(argv[1]));
        const trace = listFor(keys[0]);
        trace.unshift(String(argv[1]));
        trace.splice(Math.max(0, Number(argv[2]) || 100));
        values.set(keys[2], String(argv[4]));
        return JSON.stringify({ ok: true, duplicate: false, event: String(argv[1]) });
      }
      if (script.includes("userRaw=redis.call('GET',KEYS[1])") && script.includes("authVersion=current")) {
        const userRaw = values.get(keys[0]);
        if (!userRaw) return JSON.stringify({ ok: false, error: "session_revoked" });
        const authVersion = Number(values.get(keys[1]) || 1);
        const lifecycleRaw = values.get(keys[3]);
        const lifecycle = /^[a-f0-9]{32}$/.test(String(lifecycleRaw || ""))
          ? lifecycleRaw
          : String(argv[0] || "");
        if (!/^[a-f0-9]{32}$/.test(String(lifecycle || ""))) {
          return JSON.stringify({ ok: false, error: "invalid_lifecycle_candidate" });
        }
        if (lifecycle !== lifecycleRaw) values.set(keys[3], lifecycle);
        return JSON.stringify({
          ok: true,
          userRaw,
          authVersion,
          accountLifecycleId: lifecycle,
          balanceCents: values.get(keys[2]) ?? null,
        });
      }
      // Empty stores make legacy migration and optional cache Lua scripts no-ops.
      return null;
    }
    return null;
  }

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.origin !== origin) return originalFetch(input, options);
    requestCount += 1;
    if (url.pathname === "/pipeline") {
      const batch = JSON.parse(options.body || "[]");
      return Response.json(batch.map((command) => ({ result: execute(command) })));
    }
    return Response.json({ result: execute(url.pathname.split("/").filter(Boolean).map(decodeURIComponent)) });
  };

  return {
    values, sets, lists, hashes, sortedSets, commands,
    get requestCount() { return requestCount; },
    failNextCommand(name, keyPrefix = "", result = null, argumentIndex = 0) {
      commandFailures.push({
        name: String(name || "").toUpperCase(),
        keyPrefix: String(keyPrefix || ""),
        result,
        argumentIndex: Math.max(0, Number(argumentIndex) || 0),
      });
    },
    execute,
    restore() { globalThis.fetch = originalFetch; },
  };
}
