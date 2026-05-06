import {
  getCookieFromRequest, verifySession, clean, createWithdrawal,
} from "../../_utils.js";

const MESSAGES = {
  missing_required_fields: "请填写提现金额、支付宝账号和姓名",
  insufficient_balance: "余额不足,无法提交提现",
};

export async function POST(request) {
  const token = getCookieFromRequest(request, "lm_user");
  const session = verifySession(token);
  if (!session || !session.email) return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await createWithdrawal(session.email, body.amount, body.alipayAccount, body.realName);
  if (!result.ok) {
    const code = clean(result.error, 80);
    return Response.json({ ok: false, error: code, message: MESSAGES[code] || "提现提交失败" }, { status: 400 });
  }
  return Response.json({ ok: true, balance: result.balance, withdrawal: result.withdrawal, message: "提现申请已提交,状态为待审核" });
}
