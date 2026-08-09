import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

process.env.KV_REST_API_URL = "http://money.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";

const money = await import("../app/api/_money.js");

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function realRedis(container) {
  const run = (command) => {
    const child = docker(["exec", container, "redis-cli", "--json", ...command.map(String)]);
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || "redis-cli failed");
    const output = child.stdout.trim();
    return output ? JSON.parse(output) : null;
  };
  return {
    run,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/pipeline") {
        const commands = JSON.parse(String(init.body || "[]"));
        return Response.json(commands.map((command) => {
          try { return { result: run(command) }; } catch (error) { return { error: String(error?.message || error) }; }
        }));
      }
      const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
      try { return Response.json({ result: run(command) }); } catch (error) { return Response.json({ error: String(error?.message || error) }); }
    },
  };
}

function validAuthVersionRaw(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 9007199254740990;
}

function validBalanceRaw(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

class AtomicRedisMock {
  constructor(entries = []) {
    this.values = new Map(entries);
    this.sets = new Map();
    this.evalCalls = [];
    for (const key of Array.from(this.values.keys())) {
      const match = /^liumeiti:users:([^:]+@[^:]+)$/.exec(key);
      if (!match) continue;
      const email = match[1];
      if (!this.values.has(`lm:user:authver:${email}`)) this.values.set(`lm:user:authver:${email}`, "1");
      if (!this.values.has(`lm:user:lifecycle:${email}`)) this.values.set(`lm:user:lifecycle:${email}`, lifecycleId(email));
    }
  }

  json(key) {
    const raw = this.values.get(key);
    return raw == null ? null : JSON.parse(raw);
  }

  balance(key, user) {
    const raw = this.values.get(key);
    return raw == null ? Math.round(Number(user.balance || 0) * 100) : Number(raw);
  }

  listPush(key, value) {
    const list = Array.isArray(this.values.get(key)) ? this.values.get(key) : [];
    list.unshift(value);
    this.values.set(key, list);
  }

  setAdd(key, value) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const target = this.sets.get(key);
    const added = target.has(value) ? 0 : 1;
    target.add(value);
    return added;
  }

  keyType(key) {
    if (this.values.has(key)) return typeof this.values.get(key) === "string" ? "string" : "other";
    if (this.sets.has(key)) return "set";
    return "none";
  }

  deleteKey(key) {
    this.values.delete(key);
    this.sets.delete(key);
  }

  setString(key, value) {
    this.deleteKey(key);
    this.values.set(key, String(value));
  }

  existing(opKey, hash) {
    const raw = this.values.get(opKey);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (record.requestHash !== hash) return { ok: false, error: "idempotency_conflict" };
    return { ...record.result, idempotent: true };
  }

  saveOp(opKey, hash, result) {
    this.values.set(opKey, JSON.stringify({ requestHash: hash, result }));
    return result;
  }

  verifyPrincipal(userKey, versionKey, lifecycleKey, expectedVersion, expectedLifecycle) {
    const user = this.json(userKey);
    if (!user) return { ok: false, error: "session_state_changed" };
    if (user.banned) return { ok: false, error: "account_banned" };
    const version = this.values.has(versionKey) ? Number(this.values.get(versionKey)) : 1;
    if (version !== Number(expectedVersion)) return { ok: false, error: "session_state_changed" };
    if (this.values.get(lifecycleKey) !== expectedLifecycle) return { ok: false, error: "account_lifecycle_changed" };
    return null;
  }

  eval(command) {
    const script = command[1];
    const count = Number(command[2]);
    const keys = command.slice(3, 3 + count);
    const args = command.slice(3 + count);
    this.evalCalls.push({ script, keys, args });

    if (script.includes("canonical cents key is authoritative")) {
      const next = JSON.parse(args[0]);
      const current = this.json(keys[0]);
      if (args[2] === "1" && current) return { ok: false, error: "user_exists" };
      if (args[3] === "1" && !current) return { ok: false, error: "user_not_found" };
      const authVersion = this.values.has(keys[2]) ? Number(this.values.get(keys[2])) : 1;
      const expectedAuthVersion = Number(args[1] || 0);
      if (expectedAuthVersion > 0 && expectedAuthVersion !== authVersion) {
        return { ok: false, error: "session_state_changed" };
      }
      const currentLifecycle = current ? this.values.get(keys[4]) : null;
      const expectedLifecycle = String(args[6] || "");
      if (expectedLifecycle && currentLifecycle !== expectedLifecycle) {
        return { ok: false, error: "account_lifecycle_changed" };
      }
      const cents = this.values.has(keys[1])
        ? Number(this.values.get(keys[1]))
        : Math.round(Number(current?.balance ?? next.balance ?? 0) * 100);
      this.values.set(keys[1], String(cents));
      const merged = { ...next };
      if (current) {
        for (const field of ["passwordHash", "passwordResetAt", "banned", "bannedAt", "bannedByStaffId", "unbannedByStaffId", "coupons", "referralStats"]) {
          if (Object.prototype.hasOwnProperty.call(current, field)) merged[field] = current[field];
        }
      }
      merged.balance = cents / 100;
      this.values.set(keys[0], JSON.stringify(merged));
      const accountLifecycleId = current
        ? (this.values.get(keys[4]) || args[5])
        : args[5];
      this.values.set(keys[4], accountLifecycleId);
      this.setAdd(keys[3], args[4]);
      return { ok: true, balance: cents / 100, balanceCents: cents, authVersion, accountLifecycleId };
    }

    if (script.includes("READ_USER_AUTH_STATE_V3") || script.includes("FORCE_REPAIR_USER_AUTH_STATE_V1")) {
      const userRaw = this.keyType(keys[0]) === "string" ? this.values.get(keys[0]) : null;
      if (!userRaw) return { ok: false, error: "session_revoked" };

      const versionRaw = this.keyType(keys[1]) === "string" ? this.values.get(keys[1]) : null;
      const repairedAuthVersion = !validAuthVersionRaw(versionRaw);
      const authVersion = repairedAuthVersion ? 1 : Number(versionRaw);
      if (repairedAuthVersion) this.setString(keys[1], "1");

      const balanceRaw = this.keyType(keys[2]) === "string" ? this.values.get(keys[2]) : null;
      const repairedBalance = this.keyType(keys[2]) !== "none" && !validBalanceRaw(balanceRaw);
      const balanceCents = validBalanceRaw(balanceRaw) ? balanceRaw : null;
      if (repairedBalance) this.deleteKey(keys[2]);

      const lifecycleRaw = this.keyType(keys[3]) === "string" ? this.values.get(keys[3]) : null;
      const repairedLifecycle = !/^[a-f0-9]{32}$/.test(String(lifecycleRaw || ""));
      const accountLifecycleId = repairedLifecycle ? args[0] : lifecycleRaw;
      if (!/^[a-f0-9]{32}$/.test(String(accountLifecycleId || ""))) {
        return { ok: false, error: "invalid_lifecycle_candidate" };
      }
      if (repairedLifecycle) this.setString(keys[3], accountLifecycleId);
      return {
        ok: true,
        userRaw,
        authVersion,
        accountLifecycleId,
        balanceCents,
        repairedAuthVersion,
        repairedBalance,
        repairedLifecycle,
      };
    }

    let guardError = null;
    if (script.includes("RECOVER_AUTHENTICATED_ORDER_OPERATION_V1")) {
      guardError = this.verifyPrincipal(keys[1], keys[2], keys[3], args[1], args[2]);
    } else if (script.includes("recipientBalanceCents")) {
      guardError = this.verifyPrincipal(keys[1], keys[5], keys[6], args[6], args[7]);
    } else if (script.includes("service_code_checkout_required")) {
      guardError = this.verifyPrincipal(keys[1], keys[4], keys[5], args[5], args[6]);
    } else if (script.includes("withdrawal.username")) {
      guardError = this.verifyPrincipal(keys[1], keys[3], keys[4], args[5], args[6]);
    } else if (script.includes("Commit phase: every mutation") && args[23] === "1") {
      guardError = this.verifyPrincipal(keys[8], keys[17], keys[18], args[24], args[25]);
    } else if (script.includes("referralDelta")) {
      const effectUser = this.json(keys[1]);
      if (!effectUser) guardError = { ok: false, error: "account_lifecycle_changed" };
      else if (!/^[a-f0-9]{32}$/.test(String(args[8] || ""))) guardError = { ok: false, error: "account_lifecycle_required" };
      else if (this.values.get(keys[5]) !== args[8]) guardError = { ok: false, error: "account_lifecycle_changed" };
    }
    if (guardError) return guardError;
    const prior = this.existing(keys[0], args[0]);
    if (prior) return script.includes("RECOVER_AUTHENTICATED_ORDER_OPERATION_V1")
      ? { ...prior, recovered: true }
      : prior;

    if (script.includes("RECOVER_AUTHENTICATED_ORDER_OPERATION_V1")) {
      return { ok: true, found: false };
    }

    if (script.includes("recipientBalanceCents")) {
      const from = this.json(keys[1]);
      const to = this.json(keys[2]);
      if (!from) return { ok: false, error: "user_not_found" };
      if (!to) return { ok: false, error: "recipient_not_found" };
      const amount = Number(args[1]);
      const fromBefore = this.balance(keys[3], from);
      const toBefore = this.balance(keys[4], to);
      if (fromBefore < amount) return { ok: false, error: "insufficient_balance" };
      const fromAfter = fromBefore - amount;
      const toAfter = toBefore + amount;
      from.balance = fromAfter / 100;
      to.balance = toAfter / 100;
      this.values.set(keys[1], JSON.stringify(from));
      this.values.set(keys[2], JSON.stringify(to));
      this.values.set(keys[3], String(fromAfter));
      this.values.set(keys[4], String(toAfter));
      this.listPush(keys[7], args[2]);
      this.listPush(keys[8], args[3]);
      return this.saveOp(keys[0], args[0], {
        ok: true, balance: fromAfter / 100, balanceCents: fromAfter,
        recipientBalance: toAfter / 100, recipientBalanceCents: toAfter,
        transferId: JSON.parse(args[2]).transferId,
      });
    }

    if (script.includes("referralDelta")) {
      const user = this.json(keys[1]);
      if (!user) {
        if (args[7] === "1") return this.saveOp(keys[0], args[0], { ok: true, skipped: "user_not_found", effectId: args[5] });
        return { ok: false, error: "user_not_found" };
      }
      if (user.banned && args[7] === "1") {
        return this.saveOp(keys[0], args[0], { ok: true, skipped: "account_banned", effectId: args[5] });
      }
      const before = this.balance(keys[2], user);
      const delta = Number(args[1]);
      const after = before + delta;
      if (args[2] !== "1" && after < 0) return { ok: false, error: "insufficient_balance" };
      user.balance = after / 100;
      this.values.set(keys[1], JSON.stringify(user));
      this.values.set(keys[2], String(after));
      this.listPush(keys[3], args[3]);
      return this.saveOp(keys[0], args[0], {
        ok: true, balance: after / 100, balanceCents: after,
        balanceBefore: before / 100, balanceBeforeCents: before,
        transaction: JSON.parse(args[3]), effectId: args[5],
      });
    }

    if (script.includes("withdrawal.username")) {
      const user = this.json(keys[1]);
      if (!user) return { ok: false, error: "user_not_found" };
      const before = this.balance(keys[2], user);
      const amount = Number(args[1]);
      if (before < amount) return { ok: false, error: "insufficient_balance" };
      const after = before - amount;
      const withdrawal = JSON.parse(args[2]);
      user.balance = after / 100;
      this.values.set(keys[1], JSON.stringify(user));
      this.values.set(keys[2], String(after));
      this.values.set(keys[5], JSON.stringify(withdrawal));
      this.listPush(keys[6], withdrawal.id);
      return this.saveOp(keys[0], args[0], { ok: true, balance: after / 100, balanceCents: after, withdrawal });
    }

    if (script.includes("currentRevision=tonumber(withdrawal.revision")) {
      const withdrawal = this.json(keys[3]);
      if (!withdrawal) return { ok: false, error: "withdrawal_not_found" };
      const expected = Number(args[1]);
      if (expected !== Number(withdrawal.revision || 0)) {
        return { ok: false, error: "stale_revision", currentRevision: Number(withdrawal.revision || 0), withdrawal };
      }
      const old = withdrawal.status || "pending";
      const next = args[2];
      let balance = null;
      if (old !== "failed" && next === "failed") {
        const user = this.json(keys[1]);
        const before = this.balance(keys[2], user);
        const after = before + Number(withdrawal.amountCents || 0);
        user.balance = after / 100;
        balance = after / 100;
        this.values.set(keys[1], JSON.stringify(user));
        this.values.set(keys[2], String(after));
      }
      withdrawal.status = next;
      withdrawal.revision = Number(withdrawal.revision || 0) + 1;
      this.values.set(keys[3], JSON.stringify(withdrawal));
      return this.saveOp(keys[0], args[0], { ok: true, changed: true, from: old, to: next, balance, withdrawal });
    }

    if (script.includes("service_code_checkout_required")) {
      const user = this.json(keys[1]);
      const code = this.json(keys[3]);
      if (!code) return { ok: false, error: "code_not_found" };
      if (code.status !== "active") return { ok: false, error: "code_unavailable" };
      const before = this.balance(keys[2], user);
      const delta = Math.round(Number(code.amount) * 100);
      const after = before + delta;
      Object.assign(code, JSON.parse(args[1]), { status: "used" });
      user.balance = after / 100;
      this.values.set(keys[1], JSON.stringify(user));
      this.values.set(keys[2], String(after));
      this.values.set(keys[3], JSON.stringify(code));
      return this.saveOp(keys[0], args[0], { ok: true, balance: after / 100, balanceCents: after, amount: delta / 100, code: args[4] });
    }

    if (script.includes("Commit phase: every mutation")) {
      const order = JSON.parse(args[2]);
      const payment = args[4];
      const amount = Number(args[5]);
      const stocks = JSON.parse(args[16]);
      for (const stock of stocks) {
        const key = keys[stock.slot - 1];
        if (!this.values.has(key)) continue;
        const available = Number(this.values.get(key));
        if (available < stock.count) return { ok: false, error: "out_of_stock", soldOutService: stock.service, soldOutPlan: stock.plan };
      }
      let balance = null;
      if (payment === "balance") {
        const user = this.json(keys[8]);
        const before = this.balance(keys[9], user);
        if (before < amount) return { ok: false, error: "insufficient_balance", currentBalance: before / 100 };
        const after = before - amount;
        user.balance = after / 100;
        order.paidByBalance = true;
        balance = after / 100;
        this.values.set(keys[8], JSON.stringify(user));
        this.values.set(keys[9], String(after));
      }
      if (payment === "redeem") {
        const code = this.json(keys[12]);
        if (!code) return { ok: false, error: "code_not_found" };
        if (code.status !== "active") return { ok: false, error: "code_unavailable" };
        const fingerprint = (items) => items.map((item) => {
          const service = item.key || item.service || item.product || "";
          const plan = item.plan || item.planId || "";
          return `${service}:${plan}`;
        }).sort().join("|");
        if (fingerprint(code.services || []) !== fingerprint(order.items || [])) {
          return { ok: false, error: "service_mismatch" };
        }
        code.status = "used";
        code.usedOrderId = order.orderId;
        this.values.set(keys[12], JSON.stringify(code));
      }
      for (const stock of stocks) {
        const key = keys[stock.slot - 1];
        if (!this.values.has(key)) continue;
        this.values.set(key, String(Number(this.values.get(key)) - stock.count));
        for (const index of stock.itemIndexes) order.items[index - 1].stockReserved = true;
      }
      this.values.set(keys[1], JSON.stringify(order));
      if (this.setAdd(keys[16], order.orderId)) this.listPush(keys[2], order.orderId);
      return this.saveOp(keys[0], args[0], { ok: true, order, balance });
    }

    throw new Error("unhandled EVAL script in test");
  }

  command(command) {
    const [name, ...args] = command;
    if (name === "GET") return this.values.get(args[0]) ?? null;
    if (name === "MGET") return args.map((key) => this.values.get(key) ?? null);
    if (name === "DEL") return args.reduce((count, key) => count + Number(this.values.delete(key)), 0);
    if (name === "LRANGE") return Array.isArray(this.values.get(args[0])) ? this.values.get(args[0]) : [];
    if (name === "PING") return "PONG";
    if (name === "SADD") return args.slice(1).reduce((count, value) => count + this.setAdd(args[0], value), 0);
    if (name === "SMEMBERS") return Array.from(this.sets.get(args[0]) || []);
    if (name === "LPUSH") { for (const value of args.slice(1)) this.listPush(args[0], value); return this.values.get(args[0]).length; }
    if (name === "LTRIM") return "OK";
    if (name === "SET") { this.values.set(args[0], args[1]); return "OK"; }
    throw new Error(`unhandled command ${name}`);
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(String(init.body || "[]"));
      return Response.json(commands.map((command) => ({ result: command[0] === "EVAL" ? JSON.stringify(this.eval(command)) : this.command(command) })));
    }
    const command = url.pathname.split("/").slice(1).map(decodeURIComponent);
    return Response.json({ result: this.command(command) });
  };
}

function user(email, balance) {
  return [`liumeiti:users:${email}`, JSON.stringify({ email, balance })];
}

function lifecycleId(email) {
  return Buffer.from(String(email)).toString("hex").padEnd(32, "0").slice(0, 32);
}

function principalOptions(email, operationId) {
  return { operationId, authVersion: 1, accountLifecycleId: lifecycleId(email) };
}

async function withRedis(redis, callback) {
  const original = global.fetch;
  global.fetch = redis.fetch;
  try { return await callback(); } finally { global.fetch = original; }
}

test("money Redis double mirrors V3 auth repair for malformed and wrong-type derived keys", () => {
  const email = "auth-double@example.com";
  const keys = [
    `liumeiti:users:${email}`,
    `lm:user:authver:${email}`,
    money.balanceCentsKey(email),
    money.accountLifecycleKey(email),
  ];
  const lifecycle = "fedcba9876543210fedcba9876543210";
  const redis = new AtomicRedisMock([user(email, 12.5)]);
  redis.values.set(keys[1], [""]);
  redis.sets.set(keys[2], new Set(["12.5"]));
  redis.values.set(keys[3], { invalid: true });

  const repairedTypes = redis.eval(["EVAL", "-- READ_USER_AUTH_STATE_V3", "4", ...keys, lifecycle]);
  assert.equal(repairedTypes.ok, true);
  assert.equal(repairedTypes.authVersion, 1);
  assert.equal(repairedTypes.balanceCents, null);
  assert.equal(repairedTypes.accountLifecycleId, lifecycle);
  assert.equal(redis.values.get(keys[1]), "1");
  assert.equal(redis.keyType(keys[2]), "none");
  assert.equal(redis.values.get(keys[3]), lifecycle);

  redis.values.set(keys[1], "");
  redis.values.set(keys[2], "12.5");
  redis.values.set(keys[3], "INVALID-LIFECYCLE");
  const forced = redis.eval(["EVAL", "-- FORCE_REPAIR_USER_AUTH_STATE_V1", "4", ...keys, lifecycle]);
  assert.equal(forced.ok, true);
  assert.equal(forced.authVersion, 1);
  assert.equal(forced.balanceCents, null);
  assert.equal(forced.accountLifecycleId, lifecycle);
});

test("concurrent transfers cannot spend the same balance twice", async () => {
  const redis = new AtomicRedisMock([
    user("a@example.com", 100), user("b@example.com", 0), user("c@example.com", 0),
    [money.balanceCentsKey("a@example.com"), "10000"],
  ]);
  await withRedis(redis, async () => {
    const results = await Promise.all([
      money.transferBalanceAtomic("a@example.com", "b@example.com", 100, principalOptions("a@example.com", "transfer-key-0001")),
      money.transferBalanceAtomic("a@example.com", "c@example.com", 100, principalOptions("a@example.com", "transfer-key-0002")),
    ]);
    assert.equal(results.filter((item) => item.ok).length, 1);
    assert.equal(Number(redis.values.get(money.balanceCentsKey("a@example.com"))), 0);
    const total = ["a@example.com", "b@example.com", "c@example.com"]
      .reduce((sum, email) => sum + Number(redis.values.get(money.balanceCentsKey(email)) || 0), 0);
    assert.equal(total, 10000);
  });
});

test("transfer and withdrawal retries reuse the first result and reject key reuse with another payload", async () => {
  const redis = new AtomicRedisMock([user("a@example.com", 200), user("b@example.com", 0), [money.balanceCentsKey("a@example.com"), "20000"]]);
  await withRedis(redis, async () => {
    const first = await money.transferBalanceAtomic("a@example.com", "b@example.com", 50, principalOptions("a@example.com", "retry-key-0001"));
    const retry = await money.transferBalanceAtomic("a@example.com", "b@example.com", 50, principalOptions("a@example.com", "retry-key-0001"));
    const conflict = await money.transferBalanceAtomic("a@example.com", "b@example.com", 60, principalOptions("a@example.com", "retry-key-0001"));
    assert.equal(first.ok, true);
    assert.equal(retry.idempotent, true);
    assert.equal(conflict.error, "idempotency_conflict");
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "15000");

    const withdrawals = await Promise.all([
      money.createWithdrawalAtomic("a@example.com", 100, "ali-a", "A", principalOptions("a@example.com", "withdraw-key-01")),
      money.createWithdrawalAtomic("a@example.com", 100, "ali-b", "A", principalOptions("a@example.com", "withdraw-key-02")),
    ]);
    assert.equal(withdrawals.filter((item) => item.ok).length, 1);
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "5000");
  });
});

test("money commits reject stale auth versions and deleted-account lifecycles before operation lookup", async () => {
  const codeKey = "liumeiti:redeem-code:LIFECYCLE1";
  const redis = new AtomicRedisMock([
    user("a@example.com", 200), user("b@example.com", 0),
    [money.balanceCentsKey("a@example.com"), "20000"],
    [codeKey, JSON.stringify({ code: "LIFECYCLE1", status: "active", type: "balance", amount: 25 })],
  ]);
  await withRedis(redis, async () => {
    const original = principalOptions("a@example.com", "lifecycle-op-01");

    redis.values.set("lm:user:authver:a@example.com", "2");
    const staleSession = await money.transferBalanceAtomic("a@example.com", "b@example.com", 10, original);
    assert.equal(staleSession.error, "session_state_changed");
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "20000");

    redis.values.set("lm:user:authver:a@example.com", "1");
    redis.values.set("lm:user:lifecycle:a@example.com", "f".repeat(32));
    const staleTransfer = await money.transferBalanceAtomic("a@example.com", "b@example.com", 10, original);
    const staleRedeem = await money.redeemBalanceCodeAtomic(
      "a@example.com", "LIFECYCLE1", {}, { ...original, operationId: "lifecycle-redeem-01" },
    );
    const staleWithdrawal = await money.createWithdrawalAtomic(
      "a@example.com", 10, "ali-a", "A", { ...original, operationId: "lifecycle-withdraw-01" },
    );
    assert.deepEqual(
      [staleTransfer.error, staleRedeem.error, staleWithdrawal.error],
      ["account_lifecycle_changed", "account_lifecycle_changed", "account_lifecycle_changed"],
    );
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "20000");
    assert.equal(redis.json(codeKey).status, "active");
  });
});

test("a new session in the same account lifecycle can recover a completed money operation", async () => {
  const redis = new AtomicRedisMock([
    user("a@example.com", 50), user("b@example.com", 0),
    [money.balanceCentsKey("a@example.com"), "5000"],
  ]);
  await withRedis(redis, async () => {
    const first = await money.transferBalanceAtomic(
      "a@example.com", "b@example.com", 10, principalOptions("a@example.com", "session-replay-01"),
    );
    assert.equal(first.ok, true);
    redis.values.set("lm:user:authver:a@example.com", "2");
    const retry = await money.transferBalanceAtomic("a@example.com", "b@example.com", 10, {
      ...principalOptions("a@example.com", "session-replay-01"),
      authVersion: 2,
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.idempotent, true);
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "4000");
  });
});

test("one balance redeem code can credit only one concurrent request", async () => {
  const codeKey = "liumeiti:redeem-code:ONETIME1";
  const redis = new AtomicRedisMock([
    user("a@example.com", 0), user("b@example.com", 0),
    [codeKey, JSON.stringify({ code: "ONETIME1", status: "active", type: "balance", amount: 88 })],
  ]);
  await withRedis(redis, async () => {
    const results = await Promise.all([
      money.redeemBalanceCodeAtomic("a@example.com", "ONETIME1", {}, principalOptions("a@example.com", "redeem-key-0001")),
      money.redeemBalanceCodeAtomic("b@example.com", "ONETIME1", {}, principalOptions("b@example.com", "redeem-key-0002")),
    ]);
    assert.equal(results.filter((item) => item.ok).length, 1);
    const total = Number(redis.values.get(money.balanceCentsKey("a@example.com")) || 0)
      + Number(redis.values.get(money.balanceCentsKey("b@example.com")) || 0);
    assert.equal(total, 8800);
    assert.equal(redis.json(codeKey).status, "used");
  });
});

test("semantic effect id wins over caller operation id", async () => {
  const redis = new AtomicRedisMock([user("a@example.com", 0)]);
  await withRedis(redis, async () => {
    const expectedAccountLifecycleId = lifecycleId("a@example.com");
    const first = await money.applyBalanceEffectAtomic({ email: "a@example.com", delta: 25, effectId: "refund:ORDER1", operationId: "request-a", expectedAccountLifecycleId });
    const second = await money.applyBalanceEffectAtomic({ email: "a@example.com", delta: 25, effectId: "refund:ORDER1", operationId: "request-b", expectedAccountLifecycleId });
    assert.equal(first.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "2500");
    assert.equal(redis.evalCalls[0].keys[0], redis.evalCalls[1].keys[0]);
  });
});

test("a committed balance effect cannot cross account re-registration", async () => {
  const email = "recreated@example.com";
  const oldLifecycle = lifecycleId(email);
  const newLifecycle = "f".repeat(32);
  const redis = new AtomicRedisMock([user(email, 0), [money.balanceCentsKey(email), "0"]]);

  await withRedis(redis, async () => {
    const effect = {
      email,
      delta: 25,
      effectId: "refund:RECREATED-ORDER-1",
    };
    const first = await money.applyBalanceEffectAtomic({
      ...effect,
      expectedAccountLifecycleId: oldLifecycle,
    });
    assert.equal(first.ok, true);
    assert.equal(redis.values.get(money.balanceCentsKey(email)), "2500");
    const firstOperationKey = redis.evalCalls.at(-1).keys[0];

    // Model account deletion followed by a fresh registration at the same
    // email. The permanent semantic operation record deliberately survives.
    redis.values.set(`liumeiti:users:${email}`, JSON.stringify({ email, balance: 0 }));
    redis.values.set(money.balanceCentsKey(email), "0");
    redis.values.set(`lm:user:lifecycle:${email}`, newLifecycle);

    const staleRetry = await money.applyBalanceEffectAtomic({
      ...effect,
      expectedAccountLifecycleId: oldLifecycle,
    });
    assert.equal(staleRetry.error, "account_lifecycle_changed");
    assert.equal(redis.values.get(money.balanceCentsKey(email)), "0");

    const reboundRetry = await money.applyBalanceEffectAtomic({
      ...effect,
      expectedAccountLifecycleId: newLifecycle,
    });
    assert.equal(reboundRetry.error, "idempotency_conflict");
    assert.equal(redis.values.get(money.balanceCentsKey(email)), "0");
    assert.ok(redis.evalCalls.slice(-2).every((call) => call.keys[0] === firstOperationKey));
  });
});

test("profile save cannot roll canonical balance back", async () => {
  const redis = new AtomicRedisMock([user("a@example.com", 100), [money.balanceCentsKey("a@example.com"), "10000"]]);
  await withRedis(redis, async () => {
    await money.applyBalanceEffectAtomic({
      email: "a@example.com",
      delta: -40,
      effectId: "purchase:ORDER2",
      expectedAccountLifecycleId: lifecycleId("a@example.com"),
    });
    const saved = await money.saveUserPreservingBalanceAtomic("a@example.com", { email: "a@example.com", username: "new-name", balance: 100, coupons: [] });
    assert.equal(saved.ok, true);
    assert.equal(saved.balance, 60);
    assert.equal(Array.isArray(redis.json("liumeiti:users:a@example.com").coupons), true);
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "6000");
  });
});

test("create-only profile save cannot overwrite a concurrently registered account", async () => {
  const existing = {
    email: "a@example.com",
    passwordHash: "winner-password",
    balance: 0,
    coupons: [],
  };
  const redis = new AtomicRedisMock([["liumeiti:users:a@example.com", JSON.stringify(existing)]]);
  await withRedis(redis, async () => {
    const result = await money.saveUserPreservingBalanceAtomic("a@example.com", {
      email: "a@example.com",
      passwordHash: "stale-password",
      balance: 0,
      coupons: [],
    }, { createOnly: true });
    assert.deepEqual(result, { ok: false, error: "user_exists" });
    assert.equal(redis.json("liumeiti:users:a@example.com").passwordHash, "winner-password");
  });
});

test("profile creation preserves an auth-version tombstone and lifecycle-pinned updates fail closed", async () => {
  const authKey = "lm:user:authver:a@example.com";
  const redis = new AtomicRedisMock([[authKey, "6"]]);
  await withRedis(redis, async () => {
    const created = await money.saveUserPreservingBalanceAtomic("a@example.com", {
      email: "a@example.com",
      username: "new-lifecycle",
      balance: 0,
      coupons: [],
    }, { createOnly: true });
    assert.equal(created.ok, true);
    assert.equal(created.authVersion, 6);
    assert.match(created.accountLifecycleId, /^[a-f0-9]{32}$/);
    assert.equal(redis.values.get("lm:user:lifecycle:a@example.com"), created.accountLifecycleId);
    assert.equal(redis.sets.get("liumeiti:users:emails").has("a@example.com"), true);
    assert.equal(redis.values.get(authKey), "6");

    const originalLifecycle = created.accountLifecycleId;
    const replacementLifecycle = "f".repeat(32);
    redis.values.set("liumeiti:users:a@example.com", JSON.stringify({
      email: "a@example.com",
      username: "replacement-lifecycle",
      balance: 0,
      coupons: [],
    }));
    redis.values.set("lm:user:lifecycle:a@example.com", replacementLifecycle);
    const staleLifecycle = await money.saveUserPreservingBalanceAtomic("a@example.com", {
      email: "a@example.com",
      username: "stale-old-lifecycle",
      balance: 0,
      coupons: [],
    }, {
      updateOnly: true,
      expectedAuthVersion: 6,
      expectedAccountLifecycleId: originalLifecycle,
    });
    assert.deepEqual(staleLifecycle, { ok: false, error: "account_lifecycle_changed" });
    assert.equal(redis.json("liumeiti:users:a@example.com").username, "replacement-lifecycle");

    redis.values.set(authKey, "7");
    const stale = await money.saveUserPreservingBalanceAtomic("a@example.com", {
      email: "a@example.com",
      username: "stale-writer",
      balance: 0,
      coupons: [],
    }, { updateOnly: true, expectedAuthVersion: 6 });
    assert.deepEqual(stale, { ok: false, error: "session_state_changed" });
    assert.equal(redis.json("liumeiti:users:a@example.com").username, "replacement-lifecycle");
  });
});

test("a banned referral recipient in the same lifecycle is a stable skipped effect", async () => {
  const email = "blocked@example.com";
  const redis = new AtomicRedisMock([[`liumeiti:users:${email}`, JSON.stringify({ email, balance: 0, banned: true })]]);
  await withRedis(redis, async () => {
    const input = {
      email,
      delta: 5,
      effectId: "referral:LM1:cycle:1:level:1",
      source: "referral",
      referralCommissionDelta: 5,
      skipUnavailable: true,
      expectedAccountLifecycleId: lifecycleId(email),
    };
    const first = await money.applyBalanceEffectAtomic(input);
    assert.equal(first.skipped, "account_banned");
    redis.values.set(`liumeiti:users:${email}`, JSON.stringify({ email, balance: 0, banned: false }));
    const retry = await money.applyBalanceEffectAtomic(input);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.skipped, "account_banned");
    assert.equal(redis.values.has(money.balanceCentsKey(email)), false);
  });
});

test("a missing referral lifecycle fails closed before an old operation can be recovered", async () => {
  const email = "missing@example.com";
  const expectedAccountLifecycleId = lifecycleId(email);
  const redis = new AtomicRedisMock();
  await withRedis(redis, async () => {
    const input = {
      email,
      delta: 5,
      effectId: "referral:LM-MISSING:cycle:1:level:1",
      source: "referral",
      referralCommissionDelta: 5,
      skipUnavailable: true,
      expectedAccountLifecycleId,
    };
    const missing = await money.applyBalanceEffectAtomic(input);
    assert.equal(missing.error, "account_lifecycle_changed");

    redis.values.set(`liumeiti:users:${email}`, JSON.stringify({ email, balance: 0 }));
    redis.values.set(`lm:user:lifecycle:${email}`, "f".repeat(32));
    const replacement = await money.applyBalanceEffectAtomic(input);
    assert.equal(replacement.error, "account_lifecycle_changed");
    assert.equal(redis.values.has(money.balanceCentsKey(email)), false);
  });
});

test("legacy referral settlement records manual evidence without paying or blocking order completion", async () => {
  const email = "legacy-inviter@example.com";
  const redis = new AtomicRedisMock([user(email, 0), [money.balanceCentsKey(email), "0"]]);
  await withRedis(redis, async () => {
    const { settleOrderReferralCommission } = await import("../app/api/_utils.js");
    const order = {
      orderId: "LM-LEGACY-REFERRAL-1",
      finalAmount: 100,
      referral: {
        levelOneEmail: email,
        levelOneRate: 0.1,
        // Historical orders did not capture levelOneAccountLifecycleId.
      },
    };
    const settled = await settleOrderReferralCommission(order);
    assert.equal(settled.ok, true);
    assert.equal(settled.manualReview, true);
    assert.deepEqual(settled.entries, []);
    assert.equal(settled.skippedEntries.length, 1);
    assert.equal(settled.skippedEntries[0].reason, "referral_account_lifecycle_required");
    assert.equal(order.referralCommissionManualReview.required, true);
    assert.match(order.referralCommissionSettledAt, /^\d{4}-/);
    assert.equal(redis.values.get(money.balanceCentsKey(email)), "0");

    const retry = await settleOrderReferralCommission(order);
    assert.equal(retry.ok, true);
    assert.equal(retry.skipped, "already_settled");
    assert.equal(redis.values.get(money.balanceCentsKey(email)), "0");
  });
});

test("referral settlement never credits a re-registered inviter lifecycle", async () => {
  const email = "rebound-inviter@example.com";
  const oldLifecycle = "a".repeat(32);
  const replacementLifecycle = "b".repeat(32);
  const redis = new AtomicRedisMock([
    user(email, 0),
    [money.balanceCentsKey(email), "0"],
    [money.accountLifecycleKey(email), replacementLifecycle],
  ]);
  await withRedis(redis, async () => {
    const { settleOrderReferralCommission } = await import("../app/api/_utils.js");
    const order = {
      orderId: "LM-REBOUND-REFERRAL-1",
      finalAmount: 100,
      referral: {
        levelOneEmail: email,
        levelOneAccountLifecycleId: oldLifecycle,
        levelOneRate: 0.1,
      },
    };
    const settled = await settleOrderReferralCommission(order);
    assert.equal(settled.ok, true);
    assert.equal(settled.manualReview, true);
    assert.equal(settled.skippedEntries[0].reason, "account_lifecycle_changed");
    assert.equal(order.referralCommissionEntries.length, 0);
    assert.match(order.referralCommissionSettledAt, /^\d{4}-/);
    assert.equal(redis.values.get(money.balanceCentsKey(email)), "0");
  });
});

test("opaque idempotency keys do not collide and are scoped to the authenticated principal", async () => {
  assert.notEqual(
    money.moneyKeys.operationKey("transfer:a@example.com", "opaque.key.0001"),
    money.moneyKeys.operationKey("transfer:a@example.com", "opaque_key_0001"),
  );
  assert.notEqual(
    money.moneyKeys.operationKey("transfer:a@example.com", "shared-key-0001"),
    money.moneyKeys.operationKey("transfer:b@example.com", "shared-key-0001"),
  );

  const redis = new AtomicRedisMock([
    user("a@example.com", 20), user("b@example.com", 20), user("c@example.com", 0), user("d@example.com", 0),
    [money.balanceCentsKey("a@example.com"), "2000"], [money.balanceCentsKey("b@example.com"), "2000"],
  ]);
  await withRedis(redis, async () => {
    const [first, second] = await Promise.all([
      money.transferBalanceAtomic("a@example.com", "c@example.com", 10, principalOptions("a@example.com", "shared-key-0001")),
      money.transferBalanceAtomic("b@example.com", "d@example.com", 10, principalOptions("b@example.com", "shared-key-0001")),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "1000");
    assert.equal(redis.values.get(money.balanceCentsKey("b@example.com")), "1000");
  });
});

test("order commit includes empty-plan stock and all primary indexes in one EVAL", async () => {
  const redis = new AtomicRedisMock([["liumeiti:stock:legacy:", "1"]]);
  await withRedis(redis, async () => {
    const order = {
      orderId: money.orderIdForIdempotencyKey("order-key-0001"), status: "received", paymentMethod: "alipay",
      email: "buyer@example.com", userEmail: null, finalAmount: 10, paidAmount: 10, paidCurrency: "CNY",
      createdAt: new Date(0).toISOString(), createdAtBeijing: "", items: [{ service: "legacy", plan: "", amount: 10 }],
    };
    const input = {
      order, paymentMethod: "alipay", operationId: "order-key-0001", requestHash: money.idempotencyPayloadHash({ order: 1 }),
    };
    const result = await money.commitOrderCreationAtomic(input);
    const retry = await money.commitOrderCreationAtomic(input);
    assert.equal(result.ok, true);
    assert.equal(retry.idempotent, true);
    assert.equal(result.order.revision, 1);
    assert.equal(redis.values.get("liumeiti:stock:legacy:"), "0");
    assert.equal(result.order.items[0].stockReserved, true);
    const call = redis.evalCalls.at(-1);
    assert.ok(call.keys.includes("liumeiti:orders:index"));
    assert.ok(call.keys.includes("liumeiti:orders:overview"));
    assert.ok(call.keys.includes("liumeiti:orders:summary-created"));
    assert.ok(call.keys.includes("liumeiti:orders:list-revision"));
    assert.ok(call.keys.includes("liumeiti:orders:index:members"));
    assert.ok(call.keys.includes("liumeiti:stock:legacy:"));
    assert.match(call.script, /Commit phase: every mutation/);
    assert.match(call.script, /SADD',KEYS\[17\]/);
    assert.equal(redis.values.get("liumeiti:orders:index").filter((id) => id === order.orderId).length, 1);
    assert.equal(redis.sets.get("liumeiti:orders:index:members").has(order.orderId), true);
  });
});

test("quote applications do not reserve product stock", async () => {
  const redis = new AtomicRedisMock([["liumeiti:stock:proxy-pay:quote", "3"]]);
  await withRedis(redis, async () => {
    const operationId = "quote-order-key-0001";
    const order = {
      orderId: money.orderIdForIdempotencyKey(operationId),
      orderType: "proxy_payment",
      status: "awaiting_quote",
      paymentMethod: "quote",
      email: "buyer@example.com",
      finalAmount: 0,
      createdAt: new Date(0).toISOString(),
      items: [{ service: "proxy-pay", plan: "quote", amount: 0 }],
    };
    const result = await money.commitOrderCreationAtomic({
      order,
      paymentMethod: "quote",
      operationId,
      requestHash: money.idempotencyPayloadHash({ quote: 1 }),
    });
    assert.equal(result.ok, true);
    assert.equal(redis.values.get("liumeiti:stock:proxy-pay:quote"), "3");
    assert.equal(redis.evalCalls.at(-1).keys.includes("liumeiti:stock:proxy-pay:quote"), false);
  });
});

test("two orders cannot consume one service code or overspend one balance", async () => {
  const codeKey = "liumeiti:redeem-code:SERVICE1";
  const lifecycleId = "a".repeat(32);
  const redis = new AtomicRedisMock([
    [codeKey, JSON.stringify({ code: "SERVICE1", status: "active", type: "service", services: [{ key: "legacy", plan: "" }] })],
    user("a@example.com", 100), [money.balanceCentsKey("a@example.com"), "10000"],
    ["lm:user:authver:a@example.com", "1"], [money.accountLifecycleKey("a@example.com"), lifecycleId],
  ]);
  const makeOrder = (key, paymentMethod, suffix) => ({
    orderId: money.orderIdForIdempotencyKey(key), status: "received", paymentMethod,
    email: `buyer-${suffix}@example.com`, userEmail: paymentMethod === "balance" ? "a@example.com" : null,
    finalAmount: paymentMethod === "balance" ? 100 : 0, paidAmount: paymentMethod === "balance" ? 100 : 0,
    paidCurrency: paymentMethod === "redeem" ? "CODE" : "CNY", createdAt: new Date(0).toISOString(), createdAtBeijing: "",
    items: [{ service: "legacy", plan: "", amount: 100 }], redeemServices: [{ key: "legacy", plan: "" }],
  });
  await withRedis(redis, async () => {
    const codeOrders = await Promise.all(["order-code-0001", "order-code-0002"].map((key, index) => money.commitOrderCreationAtomic({
      order: makeOrder(key, "redeem", index), paymentMethod: "redeem", redeemCode: "SERVICE1",
      operationId: key, requestHash: money.idempotencyPayloadHash({ key }),
    })));
    assert.equal(codeOrders.filter((item) => item.ok).length, 1);
    assert.equal(redis.json(codeKey).status, "used");

    const balanceOrders = await Promise.all(["order-bal-0001", "order-bal-0002"].map((key, index) => money.commitOrderCreationAtomic({
      order: makeOrder(key, "balance", index), paymentMethod: "balance", userEmail: "a@example.com",
      expectedAuthVersion: 1, expectedAccountLifecycleId: lifecycleId,
      operationId: key, requestHash: money.idempotencyPayloadHash({ key }),
    })));
    assert.equal(balanceOrders.filter((item) => item.ok).length, 1);
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "0");
  });
});

test("order commit rejects a deleted and re-registered account lifecycle before side effects", async () => {
  const email = "a@example.com";
  const oldLifecycle = "a".repeat(32);
  const newLifecycle = "b".repeat(32);
  const redis = new AtomicRedisMock([
    user(email, 100), [money.balanceCentsKey(email), "10000"],
    ["lm:user:authver:a@example.com", "3"], [money.accountLifecycleKey(email), newLifecycle],
  ]);
  const operationId = "order-old-lifecycle-0001";
  const order = {
    orderId: money.orderIdForIdempotencyKey(operationId), status: "received", paymentMethod: "balance",
    email, userEmail: email, accountLifecycleId: oldLifecycle, finalAmount: 50, paidAmount: 50,
    paidCurrency: "CNY", createdAt: new Date(0).toISOString(), items: [{ service: "legacy", plan: "", amount: 50 }],
  };
  await withRedis(redis, async () => {
    const result = await money.commitOrderCreationAtomic({
      order, paymentMethod: "balance", userEmail: email,
      expectedAuthVersion: 3, expectedAccountLifecycleId: oldLifecycle,
      operationId, requestHash: money.idempotencyPayloadHash({ lifecycle: oldLifecycle }),
    });
    assert.equal(result.error, "account_lifecycle_changed");
    assert.equal(redis.values.get(money.balanceCentsKey(email)), "10000");
    assert.equal(redis.values.has(`liumeiti:orders:record:${order.orderId}`), false);
  });
});

test("a new session in the same lifecycle recovers an order without a second deduction", async () => {
  const email = "a@example.com";
  const lifecycleId = "c".repeat(32);
  const authKey = "lm:user:authver:a@example.com";
  const redis = new AtomicRedisMock([
    user(email, 100), [money.balanceCentsKey(email), "10000"],
    [authKey, "1"], [money.accountLifecycleKey(email), lifecycleId],
  ]);
  const operationId = "order-session-recovery-0001";
  const requestHash = money.idempotencyPayloadHash({ lifecycle: lifecycleId, amount: 40 });
  const order = {
    orderId: money.orderIdForIdempotencyKey(operationId), status: "received", paymentMethod: "balance",
    email, userEmail: email, accountLifecycleId: lifecycleId, finalAmount: 40, paidAmount: 40,
    paidCurrency: "CNY", createdAt: new Date(0).toISOString(), items: [{ service: "legacy", plan: "", amount: 40 }],
  };
  await withRedis(redis, async () => {
    const first = await money.commitOrderCreationAtomic({
      order, paymentMethod: "balance", userEmail: email,
      expectedAuthVersion: 1, expectedAccountLifecycleId: lifecycleId, operationId, requestHash,
    });
    assert.equal(first.ok, true);
    assert.equal(redis.values.get(money.balanceCentsKey(email)), "6000");
    redis.values.set(authKey, "2");
    const recovered = await money.commitOrderCreationAtomic({
      order, paymentMethod: "balance", userEmail: email,
      expectedAuthVersion: 2, expectedAccountLifecycleId: lifecycleId, operationId, requestHash,
    });
    assert.equal(recovered.idempotent, true);
    assert.equal(redis.values.get(money.balanceCentsKey(email)), "6000");
  });
});

test("real Redis enforces order auth-version and lifecycle before idempotent recovery", {
  skip: process.env.RUN_REAL_REDIS_TESTS !== "1" ? "set RUN_REAL_REDIS_TESTS=1 for Docker integration" : false,
  timeout: 120_000,
}, async () => {
  const container = `lm-order-lifecycle-${process.pid}-${Date.now()}`;
  const started = docker(["run", "--rm", "-d", "--name", container, "redis:7-alpine"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ping = docker(["exec", container, "redis-cli", "PING"]);
      if (ping.status === 0 && ping.stdout.trim() === "PONG") { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const redis = realRedis(container);
    const email = "real-order@example.com";
    const lifecycleId = "d".repeat(32);
    redis.run(["SET", `liumeiti:users:${email}`, JSON.stringify({ email, balance: 100 })]);
    redis.run(["SET", money.balanceCentsKey(email), "10000"]);
    redis.run(["SET", `lm:user:authver:${email}`, "1"]);
    redis.run(["SET", money.accountLifecycleKey(email), lifecycleId]);
    const operationId = "real-order-lifecycle-0001";
    const requestHash = money.idempotencyPayloadHash({ lifecycleId, amount: 40 });
    const order = {
      orderId: money.orderIdForIdempotencyKey(operationId), status: "received", paymentMethod: "balance",
      email, userEmail: email, accountLifecycleId: lifecycleId, finalAmount: 40, paidAmount: 40,
      paidCurrency: "CNY", createdAt: new Date().toISOString(), items: [{ service: "legacy", plan: "", amount: 40 }],
    };
    await withRedis(redis, async () => {
      const first = await money.commitOrderCreationAtomic({ order, paymentMethod: "balance", userEmail: email, expectedAuthVersion: 1, expectedAccountLifecycleId: lifecycleId, operationId, requestHash });
      assert.equal(first.ok, true);
      assert.equal(redis.run(["GET", money.balanceCentsKey(email)]), "6000");
      redis.run(["SET", `lm:user:authver:${email}`, "2"]);
      const recovered = await money.commitOrderCreationAtomic({ order, paymentMethod: "balance", userEmail: email, expectedAuthVersion: 2, expectedAccountLifecycleId: lifecycleId, operationId, requestHash });
      assert.equal(recovered.idempotent, true);
      assert.equal(redis.run(["GET", money.balanceCentsKey(email)]), "6000");
      redis.run(["SET", money.accountLifecycleKey(email), "e".repeat(32)]);
      const stale = await money.commitOrderCreationAtomic({ order, paymentMethod: "balance", userEmail: email, expectedAuthVersion: 2, expectedAccountLifecycleId: lifecycleId, operationId, requestHash });
      assert.equal(stale.error, "account_lifecycle_changed");
      assert.equal(redis.run(["GET", money.balanceCentsKey(email)]), "6000");
    });
  } finally {
    docker(["rm", "-f", container]);
  }
});

test("one service entitlement cannot purchase duplicate API items", async () => {
  const codeKey = "liumeiti:redeem-code:SERVICE2";
  const redis = new AtomicRedisMock([
    [codeKey, JSON.stringify({ code: "SERVICE2", status: "active", type: "service", services: [{ key: "legacy", plan: "" }] })],
  ]);
  await withRedis(redis, async () => {
    const operationId = "duplicate-service-order-0001";
    const order = {
      orderId: money.orderIdForIdempotencyKey(operationId),
      status: "received",
      paymentMethod: "redeem",
      email: "buyer@example.com",
      finalAmount: 0,
      createdAt: new Date(0).toISOString(),
      items: [
        { service: "legacy", plan: "", amount: 100 },
        { service: "legacy", plan: "", amount: 100 },
      ],
    };
    const result = await money.commitOrderCreationAtomic({
      order,
      paymentMethod: "redeem",
      redeemCode: "SERVICE2",
      operationId,
      requestHash: money.idempotencyPayloadHash({ duplicate: 1 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "service_mismatch");
    assert.equal(redis.json(codeKey).status, "active");
  });
});

test("lost Redis HTTP response recovers the committed operation", async () => {
  const redis = new AtomicRedisMock([user("a@example.com", 100), user("b@example.com", 0), [money.balanceCentsKey("a@example.com"), "10000"]]);
  const original = global.fetch;
  let dropped = false;
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (!dropped && url.pathname === "/pipeline") {
      dropped = true;
      const command = JSON.parse(String(init.body || "[]"))[0];
      redis.eval(command);
      return new Response("upstream timeout", { status: 504 });
    }
    return redis.fetch(input, init);
  };
  try {
    const result = await money.transferBalanceAtomic("a@example.com", "b@example.com", 40, principalOptions("a@example.com", "lost-response-01"));
    assert.equal(result.ok, true);
    assert.equal(result.recovered, true);
    assert.equal(result.idempotent, true);
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "6000");
  } finally {
    global.fetch = original;
  }
});

test("concurrent withdrawal reviews use revision CAS and refund once", async () => {
  const withdrawal = { id: "WD1", userEmail: "a@example.com", amount: 100, amountCents: 10000, status: "pending", revision: 1 };
  const redis = new AtomicRedisMock([
    user("a@example.com", 0), [money.balanceCentsKey("a@example.com"), "0"],
    ["liumeiti:withdrawal:WD1", JSON.stringify(withdrawal)],
  ]);
  await withRedis(redis, async () => {
    const results = await Promise.all([
      money.transitionWithdrawalAtomic("WD1", "failed", "one", { staffId: 1 }, { operationId: "review-key-0001", expectedRevision: 1 }),
      money.transitionWithdrawalAtomic("WD1", "failed", "two", { staffId: 2 }, { operationId: "review-key-0002", expectedRevision: 1 }),
    ]);
    assert.equal(results.filter((item) => item.ok).length, 1);
    assert.equal(results.find((item) => !item.ok).error, "stale_revision");
    assert.equal(redis.values.get(money.balanceCentsKey("a@example.com")), "10000");
    assert.equal(redis.json("liumeiti:withdrawal:WD1").revision, 2);
  });
});

test("routes require scoped idempotency keys and deleted users lose canonical cents", async () => {
  const [transfer, redeem, withdraw, order, quoteOrder, utils, adminUsers] = await Promise.all([
    readFile(new URL("../app/api/auth/transfer/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/redeem/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/withdraw/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/order/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/quote-orders/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_utils.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/users/route.js", import.meta.url), "utf8"),
  ]);
  for (const source of [transfer, redeem, withdraw, order, quoteOrder]) assert.match(source, /requiredIdempotencyKey\(request\)/);
  for (const source of [order, quoteOrder]) {
    assert.match(source, /serverOperationId/);
    assert.match(source, /principal:\s*\{ accountEmail: userEmail \|\| "", accountLifecycleId: userAccountLifecycleId \}/);
    assert.match(source, /x-operation-expected-lifecycle/);
    assert.doesNotMatch(source, /findOrderCreationByIdempotencyKey\(idempotency\.key/);
  }
  assert.match(utils, /redis\.call\('DEL',KEYS\[1\],KEYS\[2\],KEYS\[3\],[^\n]+\)/);
  assert.match(utils, /accountLifecycleKey\(lower\)/);
  assert.match(utils, /balanceCentsKey\(lower\)/);
  assert.doesNotMatch(order, /setUser\(|reserveStock\(|consumeServiceRedeemCode\(/);
  assert.match(adminUsers, /export async function GET/);
  assert.match(adminUsers, /export async function POST/);
  assert.match(adminUsers, /status:\s*targetStatus/);
  assert.doesNotMatch(adminUsers, /targetState\.status === 401 \? 404 : 503/);
  const getBody = adminUsers.slice(adminUsers.indexOf("export async function GET"), adminUsers.indexOf("export async function POST"));
  assert.doesNotMatch(getBody, /applyBalanceEffectAtomic/);
});

test("admin balance adjustment preserves a malformed target profile as 409 instead of pretending Redis is unavailable", async () => {
  const email = "malformed-target@example.com";
  const redis = new AtomicRedisMock([[`liumeiti:users:${email}`, '{"email":']]);
  await withRedis(redis, async () => {
    const { signSession } = await import("../app/api/_utils.js");
    const route = await import(`../app/api/admin/users/route.js?target-status=${Date.now()}`);
    const token = signSession({
      role: "admin",
      staffRole: "finance",
      staffId: 11,
      staffUsername: "finance-a",
      exp: Date.now() + 60_000,
    });
    const response = await route.POST(new Request("http://site.test/api/admin/users", {
      method: "POST",
      headers: {
        cookie: `lm_admin=${encodeURIComponent(token)}`,
        "content-type": "application/json",
        "idempotency-key": "admin-malformed-target-0001",
      },
      body: JSON.stringify({ email, amount: 5, reason: "status mapping" }),
    }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "account_record_invalid");
  });
});

test("admin balance adjustment auto-repairs a legacy target's malformed derived auth keys", async () => {
  const email = "legacy-target@example.com";
  const redis = new AtomicRedisMock([user(email, 12.5)]);
  redis.values.set(`lm:user:authver:${email}`, "");
  redis.values.set(money.balanceCentsKey(email), "12.5");
  redis.values.set(money.accountLifecycleKey(email), "legacy-missing-lifecycle");
  await withRedis(redis, async () => {
    const { signSession } = await import("../app/api/_utils.js");
    const route = await import(`../app/api/admin/users/route.js?legacy-target=${Date.now()}`);
    const token = signSession({
      role: "admin",
      staffRole: "finance",
      staffId: 11,
      staffUsername: "finance-a",
      exp: Date.now() + 60_000,
    });
    const response = await route.POST(new Request("http://site.test/api/admin/users", {
      method: "POST",
      headers: {
        cookie: `lm_admin=${encodeURIComponent(token)}`,
        "content-type": "application/json",
        "idempotency-key": "admin-legacy-target-repair-0001",
      },
      body: JSON.stringify({ email, amount: 5, reason: "legacy repair" }),
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.balance, 17.5);
    assert.equal(redis.values.get(`lm:user:authver:${email}`), "1");
    assert.match(redis.values.get(money.accountLifecycleKey(email)), /^[a-f0-9]{32}$/);
    assert.equal(redis.values.get(money.balanceCentsKey(email)), "1750");
  });
});

test("admin balance idempotency survives staff changes and remains payload-bound", async () => {
  const redis = new AtomicRedisMock([user("member@example.com", 10), [money.balanceCentsKey("member@example.com"), "1000"]]);
  await withRedis(redis, async () => {
    const { signSession } = await import("../app/api/_utils.js");
    const route = await import(`../app/api/admin/users/route.js?money-route=${Date.now()}`);
    const expiry = Date.now() + 60_000;
    const firstToken = signSession({ role: "admin", staffRole: "finance", staffId: 11, staffUsername: "finance-a", exp: expiry });
    const retryToken = signSession({ role: "admin", staffRole: "finance", staffId: 12, staffUsername: "finance-b", exp: expiry });
    const firstHeaders = { cookie: `lm_admin=${encodeURIComponent(firstToken)}` };
    const retryHeaders = { cookie: `lm_admin=${encodeURIComponent(retryToken)}` };
    const getResponse = await route.GET(new Request("http://site.test/api/admin/users?email=member@example.com", { headers: firstHeaders }));
    const getBody = await getResponse.json();
    assert.equal(getResponse.status, 200);
    assert.equal(getBody.user.balance, 10);
    assert.equal(redis.values.get(money.balanceCentsKey("member@example.com")), "1000");

    const postResponse = await route.POST(new Request("http://site.test/api/admin/users", {
      method: "POST",
      headers: { ...firstHeaders, "content-type": "application/json", "idempotency-key": "admin-adjust-0001" },
      body: JSON.stringify({ email: "member@example.com", amount: 5, reason: "test" }),
    }));
    const postBody = await postResponse.json();
    assert.equal(postResponse.status, 200);
    assert.equal(postBody.balance, 15);
    assert.equal(postBody.transaction.staffId, 11);
    assert.equal(redis.values.get(money.balanceCentsKey("member@example.com")), "1500");

    const retryResponse = await route.POST(new Request("http://site.test/api/admin/users", {
      method: "POST",
      headers: { ...retryHeaders, "content-type": "application/json", "idempotency-key": "admin-adjust-0001" },
      body: JSON.stringify({ email: "member@example.com", amount: 5, reason: "test" }),
    }));
    const retryBody = await retryResponse.json();
    assert.equal(retryResponse.status, 200);
    assert.equal(retryBody.idempotent, true);
    assert.equal(retryBody.balance, 15);
    assert.equal(retryBody.transaction.staffId, 11);
    assert.equal(redis.values.get(money.balanceCentsKey("member@example.com")), "1500");

    const conflictResponse = await route.POST(new Request("http://site.test/api/admin/users", {
      method: "POST",
      headers: { ...retryHeaders, "content-type": "application/json", "idempotency-key": "admin-adjust-0001" },
      body: JSON.stringify({ email: "member@example.com", amount: 6, reason: "test" }),
    }));
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).error, "idempotency_conflict");
    assert.equal(redis.values.get(money.balanceCentsKey("member@example.com")), "1500");

    const differentKeyResponse = await route.POST(new Request("http://site.test/api/admin/users", {
      method: "POST",
      headers: { ...retryHeaders, "content-type": "application/json", "idempotency-key": "admin-adjust-0002" },
      body: JSON.stringify({ email: "member@example.com", amount: 5, reason: "test" }),
    }));
    const differentKeyBody = await differentKeyResponse.json();
    assert.equal(differentKeyResponse.status, 200);
    assert.equal(differentKeyBody.idempotent, false);
    assert.equal(differentKeyBody.balance, 20);
    assert.equal(differentKeyBody.transaction.staffId, 12);
    assert.equal(redis.values.get(money.balanceCentsKey("member@example.com")), "2000");
  });
});

test("single and batch order transitions share the same per-order lock", async () => {
  const [single, batch, transition] = await Promise.all([
    readFile(new URL("../app/api/admin/orders/[orderId]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/orders/batch/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/_order-transition.js", import.meta.url), "utf8"),
  ]);
  assert.match(single, /lm:order:update-lock:/);
  assert.doesNotMatch(single, /lm:order:assignment:/);
  assert.match(batch, /lm:order:update-lock:/);
  assert.match(batch, /SET", lockKey, lockToken, "NX", "EX", "120"/);
  assert.ok(batch.indexOf("getOrderEntryById(requestedOrderId)") > batch.indexOf('["SET", lockKey'));
  assert.ok(single.indexOf("if (priorMutation)") < single.indexOf("if (body.expectedRevision"));
  assert.match(single, /spotify-password-error:/);
  assert.match(single, /requiredIdempotencyKey\(request\)/);
  assert.match(single, /!idempotency\.ok[\s\S]*status: 400/);
  assert.doesNotMatch(single, /currentToken = await redisCmd/);
  assert.match(single, /normalizedOrderId\(orderId\)/);
  assert.match(single, /beginOrderTransition/);
  assert.match(single, /resumePendingOrderTransition/);
  assert.match(batch, /beginOrderTransition/);
  assert.match(batch, /resumePendingOrderTransition/);
  assert.match(transition, /adjustStockBatchEffectAtomic/);
  assert.match(transition, /completeTransitionId/);
});

test("order-create recovery rejects an operation record whose orderId belongs to another idempotency key", async () => {
  const operationId = "order-operation-identity-a";
  const otherOperationId = "order-operation-identity-b";
  const requestHash = money.idempotencyPayloadHash({ operationId, amount: 25 });
  const operationKey = money.moneyKeys.operationKey("order-create", operationId);
  const raw = JSON.stringify({
    requestHash,
    result: {
      ok: true,
      order: {
        orderId: money.orderIdForIdempotencyKey(otherOperationId),
        status: "received",
        finalAmount: 25,
      },
    },
  });
  const redis = new AtomicRedisMock([[operationKey, raw]]);

  await withRedis(redis, async () => {
    const result = await money.findOrderCreationByIdempotencyKey(operationId, requestHash);
    assert.deepEqual(result, { ok: false, error: "invalid_operation_record" });
    assert.equal(redis.values.get(operationKey), raw, "rejection must not mutate the mismatched record");
    assert.equal(redis.evalCalls.length, 0, "a read-only recovery check must not run money Lua");
  });
});
