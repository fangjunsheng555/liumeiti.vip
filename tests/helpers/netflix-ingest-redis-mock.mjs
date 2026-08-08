// 内存版 Upstash REST 模拟，覆盖 Netflix 收件入库与后台列表所用到的全部命令。
// 目的是让「webhook 入库 → 后台列表 → 用户取码」这条链路能被真实跑通。
export function createNetflixIngestRedis({ url = "https://netflix-ingest.redis.test", token = "test-token" } = {}) {
  const strings = new Map(); // key -> string
  const zsets = new Map(); // key -> Map(member -> score)
  const expiries = new Map();
  const state = { failNext: 0, failAll: false };

  function alive(key) {
    const at = expiries.get(key);
    if (at != null && at <= Date.now()) {
      strings.delete(key); zsets.delete(key); expiries.delete(key);
      return false;
    }
    return true;
  }
  function typeOf(key) {
    if (!alive(key)) return "none";
    if (strings.has(key)) return "string";
    if (zsets.has(key)) return "zset";
    return "none";
  }
  function zsetOf(key) {
    if (!alive(key)) zsets.delete(key);
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  }
  function bound(value, fallback) {
    const raw = String(value);
    if (raw === "+inf") return Number.POSITIVE_INFINITY;
    if (raw === "-inf") return Number.NEGATIVE_INFINITY;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  function run(command) {
    const parts = command.map(String);
    const op = parts[0].toUpperCase();
    const key = parts[1];
    switch (op) {
      case "PING": return "PONG";
      case "TYPE": return typeOf(key);
      case "GET": return alive(key) && strings.has(key) ? strings.get(key) : null;
      case "SET": {
        const value = parts[2];
        const rest = parts.slice(3).map((p) => p.toUpperCase());
        const nx = rest.includes("NX");
        if (nx && alive(key) && strings.has(key)) return null;
        strings.set(key, value);
        const exIndex = rest.indexOf("EX");
        if (exIndex >= 0) expiries.set(key, Date.now() + Number(parts[3 + exIndex + 1]) * 1000);
        else expiries.delete(key);
        return "OK";
      }
      case "DEL": {
        let removed = 0;
        for (const k of parts.slice(1)) {
          if (strings.delete(k) || zsets.delete(k)) removed += 1;
          expiries.delete(k);
        }
        return removed;
      }
      case "INCR": {
        const next = Number(alive(key) ? strings.get(key) || 0 : 0) + 1;
        strings.set(key, String(next));
        return next;
      }
      case "EXPIRE": {
        if (!alive(key) || (!strings.has(key) && !zsets.has(key))) return 0;
        expiries.set(key, Date.now() + Number(parts[2]) * 1000);
        return 1;
      }
      case "TTL": {
        const at = expiries.get(key);
        if (!alive(key)) return -2;
        return at == null ? -1 : Math.max(0, Math.ceil((at - Date.now()) / 1000));
      }
      case "ZADD": { zsetOf(key).set(parts[3], Number(parts[2])); return 1; }
      case "ZREM": {
        const z = zsetOf(key); let n = 0;
        for (const m of parts.slice(2)) if (z.delete(m)) n += 1;
        return n;
      }
      case "ZCARD": return zsetOf(key).size;
      case "ZREMRANGEBYSCORE": {
        const z = zsetOf(key);
        const min = bound(parts[2], Number.NEGATIVE_INFINITY);
        const max = bound(parts[3], Number.POSITIVE_INFINITY);
        let n = 0;
        for (const [m, s] of [...z]) if (s >= min && s <= max) { z.delete(m); n += 1; }
        return n;
      }
      case "ZREVRANGE": {
        const sorted = [...zsetOf(key)].sort((a, b) => b[1] - a[1]);
        const start = Number(parts[2]);
        const stop = Number(parts[3]);
        const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
        const slice = sorted.slice(start, end);
        return parts.slice(4).map((p) => p.toUpperCase()).includes("WITHSCORES")
          ? slice.flatMap(([m, s]) => [m, String(s)])
          : slice.map(([m]) => m);
      }
      case "ZREVRANGEBYSCORE": {
        const max = bound(parts[2], Number.POSITIVE_INFINITY);
        const min = bound(parts[3], Number.NEGATIVE_INFINITY);
        let rows = [...zsetOf(key)].filter(([, s]) => s >= min && s <= max).sort((a, b) => b[1] - a[1]);
        const limitIndex = parts.findIndex((p) => String(p).toUpperCase() === "LIMIT");
        if (limitIndex >= 0) {
          const offset = Number(parts[limitIndex + 1]);
          const count = Number(parts[limitIndex + 2]);
          rows = rows.slice(offset, count < 0 ? undefined : offset + count);
        }
        return rows.map(([m]) => m);
      }
      case "EVAL": {
        // 仅支持入库链路用到的两个小脚本：比对后替换 / 比对后删除
        const script = parts[1];
        const numKeys = Number(parts[2]);
        const keys = parts.slice(3, 3 + numKeys);
        const args = parts.slice(3 + numKeys);
        const current = alive(keys[0]) ? strings.get(keys[0]) : undefined;
        if (script.includes("redis.call('SET', KEYS[1], ARGV[2]")) {
          if (current !== args[0]) return 0;
          strings.set(keys[0], args[1]);
          expiries.set(keys[0], Date.now() + Number(args[2]) * 1000);
          return 1;
        }
        if (script.includes("return redis.call('DEL', KEYS[1])")) {
          if (current !== args[0]) return 0;
          strings.delete(keys[0]);
          expiries.delete(keys[0]);
          return 1;
        }
        throw new Error("unsupported_eval_script");
      }
      default:
        throw new Error(`unsupported_command:${op}`);
    }
  }

  function maybeFail() {
    if (state.failAll) return true;
    if (state.failNext > 0) { state.failNext -= 1; return true; }
    return false;
  }

  const fetchImpl = async (input, init = {}) => {
    const href = typeof input === "string" ? input : String(input?.url || input);
    if (!href.startsWith(url)) throw new Error(`unexpected_fetch:${href}`);
    if (init.headers?.Authorization !== `Bearer ${token}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    if (maybeFail()) return new Response("upstream error", { status: 500 });
    try {
      if (href === `${url}/pipeline`) {
        const commands = JSON.parse(init.body);
        return Response.json(commands.map((command) => {
          try { return { result: run(command) }; } catch (e) { return { error: String(e.message) }; }
        }));
      }
      const command = href.slice(url.length + 1).split("/").map(decodeURIComponent);
      return Response.json({ result: run(command) });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message) }), { status: 500 });
    }
  };

  return {
    url,
    token,
    fetch: fetchImpl,
    state,
    dump: () => ({ strings: new Map(strings), zsets: new Map(zsets) }),
  };
}
