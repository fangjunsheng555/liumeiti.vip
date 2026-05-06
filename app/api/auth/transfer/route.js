import {
  getCookieFromRequest, verifySession, clean, transferBalanceByEmail,
} from "../../_utils.js";

const MESSAGES = {
  invalid_recipient: "收款邮箱不正确,请核对后再试",
  recipient_not_found: "未找到该邮箱用户,请确认对方已注册登录",
  recipient_unavailable: "收款用户当前不可用",
  invalid_amount: "请输入正确的转账金额",
  insufficient_balance: "余额不足,无法转账",
};

export async function POST(request) {
  const token = getCookieFromRequest(request, "lm_user");
  const session = verifySession(token);
  if (!session || !session.email) return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await transferBalanceByEmail(session.email, body.email, body.amount);
  if (!result.ok) {
    const code = clean(result.error, 80);
    return Response.json({ ok: false, error: code, message: MESSAGES[code] || "转账失败" }, { status: 400 });
  }
  return Response.json({ ok: true, balance: result.balance, message: "转账成功" });
}
