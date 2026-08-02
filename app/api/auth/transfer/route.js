import {
  getCookieFromRequest, clean, transferBalanceByEmail,
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
  invalid_recipient: "收款邮箱不正确,请核对后再试",
  recipient_not_found: "未找到该邮箱用户,请确认对方已注册",
  recipient_unavailable: "收款用户当前不可用",
  invalid_amount: "请输入正确的转账金额",
  insufficient_balance: "余额不足,无法转账",
};

const MESSAGES_EN = {
  invalid_recipient: "Incorrect recipient email — please check and retry",
  recipient_not_found: "No user found for that email — make sure they've registered",
  recipient_unavailable: "The recipient is currently unavailable",
  invalid_amount: "Please enter a valid transfer amount",
  insufficient_balance: "Insufficient balance for this transfer",
};

export async function POST(request) {
  const auth = await authenticateUserRequest(request);
  if (!auth.ok) return userAuthErrorResponse(auth);
  const en = getCookieFromRequest(request, "locale") === "en";
  const operationAccount = verifyExpectedUserOperationAccount(request, auth.email, auth.accountLifecycleId);
  if (!operationAccount.ok) return userOperationAccountErrorResponse(operationAccount, { en });

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const idempotency = requiredIdempotencyKey(request);
  if (!idempotency.ok) return Response.json({ ok: false, error: idempotency.error }, { status: 400 });
  const result = await transferBalanceByEmail(auth.email, body.email, body.amount, {
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
        message: en ? "Balance service is temporarily unavailable" : "余额服务暂时不可用",
        ...retryableMoneyOperationFields(result),
      }, { status: 503 });
    }
    if (code === "idempotency_conflict") {
      return Response.json({ ok: false, error: code, message: en ? "This request key was already used" : "该请求标识已被使用" }, { status: 409 });
    }
    if (code === "session_state_changed" || code === "account_lifecycle_changed" || code === "account_lifecycle_required") {
      return Response.json({ ok: false, error: code, message: en ? "The account session changed. Refresh and retry the preserved request." : "账户会话已变化，请刷新后重试已保留的请求" }, { status: 409 });
    }
    return Response.json({ ok: false, error: code, message: (en ? MESSAGES_EN : MESSAGES)[code] || (en ? "Transfer failed" : "转账失败") }, { status: 400 });
  }
  return Response.json({ ok: true, balance: result.balance, message: en ? "Transfer complete" : "转账成功" });
}
