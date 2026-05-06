import {
  getCookieFromRequest, verifySession, clean, redeemCodeForUser,
} from "../../_utils.js";

const MESSAGES = {
  code_not_found: "兑换码不存在",
  code_unavailable: "兑换码已使用或已作废",
  invalid_amount: "兑换码金额无效",
  service_code_checkout_required: "这是服务兑换码,请在首页兑换入口进入订单页使用",
};

export async function POST(request) {
  const token = getCookieFromRequest(request, "lm_user");
  const session = verifySession(token);
  if (!session || !session.email) return Response.json({ ok: false, error: "not_logged_in" }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const result = await redeemCodeForUser(session.email, body.code);
  if (!result.ok) {
    const code = clean(result.error, 80);
    return Response.json({ ok: false, error: code, message: MESSAGES[code] || "兑换失败" }, { status: 400 });
  }
  return Response.json({ ok: true, balance: result.balance, message: "兑换成功,余额已到账" });
}
