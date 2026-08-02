import {
  getCookieFromRequest, clean, redeemCodeForUser, clientIpFromRequest, clientUserAgentFromRequest,
  checkRedeemRateLimit, recordRedeemRateFailure, clearRedeemRateLimit, redeemRateLimitMessage,
} from "../../_utils.js";
import {
  authenticateUserRequest,
  userAuthErrorResponse,
  userOperationAccountErrorResponse,
  verifyExpectedUserOperationAccount,
} from "../../_auth-session.js";
import { requiredIdempotencyKey } from "../../_money.js";
import {
  isRetryableMoneyOperationFailure,
  retryableMoneyOperationFields,
} from "../../../lib/money-operation-failure.js";

const MESSAGES = {
  code_not_found: "兑换码不存在",
  code_unavailable: "兑换码已使用或已作废",
  invalid_amount: "兑换码金额无效",
  service_code_checkout_required: "这是服务兑换码,请在首页兑换入口进入订单页使用",
};

const MESSAGES_EN = {
  code_not_found: "Code doesn't exist",
  code_unavailable: "Code is already used or voided",
  invalid_amount: "Invalid code amount",
  service_code_checkout_required: "This is a service code — use the redeem entry on the homepage to open the order page",
};

export async function POST(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const en = getCookieFromRequest(request, "locale") === "en";
  const operationAccount = verifyExpectedUserOperationAccount(request, auth.email, auth.accountLifecycleId);
  if (!operationAccount.ok) return userOperationAccountErrorResponse(operationAccount, { en });
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });

  const guard = await checkRedeemRateLimit(request);
  if (!guard.ok) {
    return Response.json({
      ok: false,
      error: "too_many_attempts",
      message: redeemRateLimitMessage(guard.retryAfter),
      retryAfter: guard.retryAfter,
    }, { status: 429, headers: { "Retry-After": String(guard.retryAfter || 300) } });
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await redeemCodeForUser(auth.email, body.code, {
    ip: clientIpFromRequest(request),
    userAgent: clientUserAgentFromRequest(request),
  }, {
    operationId: idempotency.key,
    authVersion: auth.authVersion,
    accountLifecycleId: auth.accountLifecycleId,
  });
  if (!result.ok) {
    const code = clean(result.error, 80);
    if (isRetryableMoneyOperationFailure(result)) {
      return Response.json({
        ok: false,
        error: code || "storage_unavailable",
        message: en ? "Redeem service is temporarily unavailable" : "兑换服务暂时不可用",
        ...retryableMoneyOperationFields(result),
      }, { status: 503 });
    }
    await recordRedeemRateFailure(guard);
    if (code === "idempotency_conflict") {
      return Response.json({ ok: false, error: code, message: en ? "This request key was already used" : "该请求标识已被使用" }, { status: 409 });
    }
    if (code === "session_state_changed" || code === "account_lifecycle_changed" || code === "account_lifecycle_required") {
      return Response.json({ ok: false, error: code, message: en ? "The account session changed. Refresh and retry the preserved request." : "账户会话已变化，请刷新后重试已保留的请求" }, { status: 409 });
    }
    return Response.json({ ok: false, error: code, message: (en ? MESSAGES_EN : MESSAGES)[code] || (en ? "Redeem failed" : "兑换失败") }, { status: 400 });
  }
  await clearRedeemRateLimit(guard);
  return Response.json({ ok: true, balance: result.balance, message: en ? "Redeemed — balance updated" : "兑换成功,余额已到账" });
}
