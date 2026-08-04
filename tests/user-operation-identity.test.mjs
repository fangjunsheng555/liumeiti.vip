import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.AUTH_SECRET ||= "user-operation-identity-test-secret-0123456789";
process.env.KV_REST_API_URL ||= "https://redis.user-operation-identity.test";
process.env.KV_REST_API_TOKEN ||= "test-token";

const {
  userOperationAccountErrorResponse,
  verifyExpectedUserOperationAccount,
} = await import("../app/api/_auth-session.js");
const authSessions = await import("../app/api/_auth-session.js");
const redeemRoute = await import("../app/api/auth/redeem/route.js");
const transferRoute = await import("../app/api/auth/transfer/route.js");
const withdrawRoute = await import("../app/api/auth/withdraw/route.js");
const LIFECYCLE_ID = "a".repeat(32);

test("an authenticated mutation requires the journal's exact account", async () => {
  const missing = verifyExpectedUserOperationAccount(
    new Request("https://www.liumeiti.vip/api/auth/transfer", { method: "POST" }),
    "buyer@example.com",
  );
  assert.deepEqual(missing, { ok: false, status: 400, error: "operation_identity_required" });

  const switched = verifyExpectedUserOperationAccount(
    new Request("https://www.liumeiti.vip/api/auth/transfer", {
      method: "POST",
      headers: { "X-Operation-Expected-Account": "original@example.com", "X-Operation-Expected-Lifecycle": LIFECYCLE_ID },
    }),
    "replacement@example.com",
    LIFECYCLE_ID,
  );
  assert.deepEqual(switched, { ok: false, status: 409, error: "operation_identity_changed" });
  const response = userOperationAccountErrorResponse(switched, { en: true });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "operation_identity_changed",
    message: "The signed-in account changed. Return to the original account to recover this operation.",
  });

  const matching = verifyExpectedUserOperationAccount(
    new Request("https://www.liumeiti.vip/api/auth/transfer", {
      method: "POST",
      headers: { "X-Operation-Expected-Account": " Buyer@Example.com ", "X-Operation-Expected-Lifecycle": LIFECYCLE_ID },
    }),
    "buyer@example.com",
    LIFECYCLE_ID,
  );
  assert.deepEqual(matching, { ok: true, email: "buyer@example.com", accountLifecycleId: LIFECYCLE_ID });

  const missingLifecycle = verifyExpectedUserOperationAccount(
    new Request("https://www.liumeiti.vip/api/auth/transfer", {
      method: "POST",
      headers: { "X-Operation-Expected-Account": "buyer@example.com" },
    }),
    "buyer@example.com",
    LIFECYCLE_ID,
  );
  assert.equal(missingLifecycle.error, "operation_lifecycle_required");
});

test("money routes reject a changed account before idempotency lookup or side effects", async () => {
  const routes = [
    ["../app/api/auth/redeem/route.js", "redeemCodeForUser(auth.email"],
    ["../app/api/auth/transfer/route.js", "transferBalanceByEmail(auth.email"],
    ["../app/api/auth/withdraw/route.js", "createWithdrawal(auth.email"],
  ];
  for (const [path, sideEffect] of routes) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const authentication = source.indexOf("await authenticateUserRequest(request)");
    const identity = source.indexOf("verifyExpectedUserOperationAccount(request, auth.email, auth.accountLifecycleId)");
    const rejection = source.indexOf("userOperationAccountErrorResponse(operationAccount", identity);
    const idempotency = source.indexOf("requiredIdempotencyKey(request)", identity);
    const mutation = source.indexOf(sideEffect, identity);
    assert.ok(authentication >= 0, `${path} authenticates first`);
    assert.ok(identity > authentication, `${path} checks the account after authentication`);
    assert.ok(rejection > identity, `${path} rejects an account mismatch`);
    assert.ok(idempotency > rejection, `${path} checks identity before idempotency state`);
    assert.ok(mutation > idempotency, `${path} checks identity before side effects`);
  }
});

test("money routes execute the account-switch guard at runtime before Redis mutation", async () => {
  const originalFetch = globalThis.fetch;
  const redisCalls = [];
  const account = "replacement@example.com";
  const userKey = `liumeiti:users:${account}`;
  const versionKey = `lm:user:authver:${account}`;
  const balanceKey = `${userKey}:balance:cents`;
  const lifecycleKey = `lm:user:lifecycle:${account}`;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/pipeline") {
      const commands = JSON.parse(String(init.body || "[]"));
      redisCalls.push(...commands);
      return Response.json(commands.map(() => ({ result: JSON.stringify({
        ok: true,
        userRaw: JSON.stringify({ email: account, username: "replacement", banned: false, balance: 25 }),
        authVersion: 1,
        accountLifecycleId: LIFECYCLE_ID,
        balanceCents: "2500",
      }) })));
    }
    const command = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    redisCalls.push(command);
    if (String(command[0] || "").toUpperCase() === "MGET") {
      const values = command.slice(1).map((key) => ({
        [userKey]: JSON.stringify({ email: account, username: "replacement", banned: false, balance: 25 }),
        [versionKey]: "1",
        [balanceKey]: "2500",
      })[key] ?? null);
      return Response.json({ result: values });
    }
    throw new Error(`unexpected Redis mutation: ${command[0] || "unknown"}`);
  };

  try {
    const token = authSessions.signUserSessionForVersion(account, 1, Date.now());
    const routes = [redeemRoute, transferRoute, withdrawRoute];
    const bodies = [
      { code: "BALANCE100" },
      { email: "recipient@example.com", amount: 10 },
      { amount: 10, alipayAccount: "payee", realName: "Buyer" },
    ];
    for (let index = 0; index < routes.length; index += 1) {
      const response = await routes[index].POST(new Request(
        `https://www.liumeiti.vip/api/auth/${["redeem", "transfer", "withdraw"][index]}`,
        {
          method: "POST",
          headers: {
            cookie: `lm_user=${encodeURIComponent(token)}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `operation-${index}`,
            "X-Operation-Expected-Account": "original@example.com",
            "X-Operation-Expected-Lifecycle": LIFECYCLE_ID,
          },
          body: JSON.stringify(bodies[index]),
        },
      ));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, "operation_identity_changed");
    }
    assert.equal(redisCalls.length, 3);
    assert.ok(redisCalls.every((command) => String(command[0]).toUpperCase() === "EVAL"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("every money and balance-redeem client sends the persisted identity", async () => {
  const paths = [
    "../app/account/page.jsx",
    "../app/components/RedeemCard.jsx",
    "../app/service-center/page.jsx",
  ];
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(
      source,
      /"X-Operation-Expected-Account": String\(pending\.identity\?\.accountEmail \|\| ""\)\.trim\(\)\.toLowerCase\(\)/,
    );
    assert.match(source, /body: JSON\.stringify\((?:pending\.payload|exactPayload)\)/);
  }
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(
      source,
      /"X-Operation-Expected-Lifecycle": String\(pending\.identity\?\.accountLifecycleId \|\| ""\)\.trim\(\)\.toLowerCase\(\)/,
    );
  }
});
