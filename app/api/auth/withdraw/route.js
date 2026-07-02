import {
  getCookieFromRequest, verifySession, clean, createWithdrawal,
} from "../../_utils.js";
import { getSettings } from "../../_settings.js";

// 提现申请 Telegram 提醒(动钱事件,失败静默不影响用户)。
async function notifyWithdrawTelegram(withdrawal, email) {
  try {
    const settings = await getSettings();
    if (!settings.notify.telegramWithdrawEnabled) return;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
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
    await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (e) {}
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
  const token = getCookieFromRequest(request, "lm_user");
  const session = verifySession(token);
  if (!session || !session.email) return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });
  const en = getCookieFromRequest(request, "locale") === "en";

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await createWithdrawal(session.email, body.amount, body.alipayAccount, body.realName);
  if (!result.ok) {
    const code = clean(result.error, 80);
    return Response.json({ ok: false, error: code, message: (en ? MESSAGES_EN : MESSAGES)[code] || (en ? "Withdrawal request failed" : "提现提交失败") }, { status: 400 });
  }
  await notifyWithdrawTelegram(result.withdrawal, session.email);
  return Response.json({ ok: true, balance: result.balance, withdrawal: result.withdrawal, message: en ? "Withdrawal request submitted — pending review" : "提现申请已提交,状态为待审核" });
}
