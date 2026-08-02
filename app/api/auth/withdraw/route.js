import {
  getCookieFromRequest, clean, createWithdrawal,
} from "../../_utils.js";
import { getSettings } from "../../_settings.js";
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
import { deliverOnce } from "../../_delivery-once.js";

// 提现申请 Telegram 提醒(动钱事件,失败静默不影响用户)。
async function notifyWithdrawTelegram(withdrawal, email) {
  const settings = await getSettings();
  if (!settings.notify.telegramWithdrawEnabled) return null;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;
  const text = [
    "💸 新提现申请(待审核)",
    "━━━━━━━━━━━━━━━━",
    `用户: ${email}`,
    `金额: ¥${Number(withdrawal?.amount || 0).toFixed(2)}`,
    `支付宝: ${withdrawal?.alipayAccount || "-"}`,
    `姓名: ${withdrawal?.realName || "-"}`,
    `时间: ${withdrawal?.createdAtBeijing || ""}`,
    "→ 后台「提现审核」处理",
  ].join("\n");
  const response = await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (response.ok) return true;
  return response.status >= 500 || response.status === 408 || response.status === 425
    ? { ok: false, uncertain: true, error: `telegram_http_${response.status}` }
    : { ok: false, retryable: true, error: `telegram_http_${response.status}` };
}

const MESSAGES = {
  missing_required_fields: "请填写提现金额、支付宝账号和姓名",
  insufficient_balance: "余额不足,无法提交提现",
};

const MESSAGES_EN = {
  missing_required_fields: "Please fill in the amount, Alipay account and name",
  insufficient_balance: "Insufficient balance for this withdrawal",
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
  const result = await createWithdrawal(auth.email, body.amount, body.alipayAccount, body.realName, {
    operationId: idempotency.key,
    username: auth.user?.username || "",
    authVersion: auth.authVersion,
    accountLifecycleId: auth.accountLifecycleId,
  });
  if (!result.ok) {
    const code = clean(result.error, 80);
    if (isRetryableMoneyOperationFailure(result)) {
      return Response.json({
        ok: false,
        error: code || "storage_unavailable",
        message: en ? "Withdrawal service is temporarily unavailable" : "提现服务暂时不可用",
        ...retryableMoneyOperationFields(result),
      }, { status: 503 });
    }
    if (code === "idempotency_conflict") {
      return Response.json({ ok: false, error: code, message: en ? "This request key was already used" : "该请求标识已被使用" }, { status: 409 });
    }
    if (code === "session_state_changed" || code === "account_lifecycle_changed" || code === "account_lifecycle_required") {
      return Response.json({ ok: false, error: code, message: en ? "The account session changed. Refresh and retry the preserved request." : "账户会话已变化，请刷新后重试已保留的请求" }, { status: 409 });
    }
    return Response.json({ ok: false, error: code, message: (en ? MESSAGES_EN : MESSAGES)[code] || (en ? "Withdrawal request failed" : "提现提交失败") }, { status: 400 });
  }
  const notice = await deliverOnce(
    `withdrawal-created:${result.withdrawal.id}:telegram`,
    () => notifyWithdrawTelegram(result.withdrawal, auth.email),
  );
  return Response.json({ ok: true, balance: result.balance, withdrawal: result.withdrawal, message: en ? "Withdrawal request submitted — pending review" : "提现申请已提交,状态为待审核" });
}
