import {
  checkRateLimit,
  generatePaymentAdjustment,
  makeId,
  rateLimitResponse,
  reserveUsdtNonce,
  signPaymentQuote,
} from "../_utils.js";

const QUOTE_TTL_MS = 30 * 60 * 1000;

export async function POST(request) {
  const guard = await checkRateLimit(request, {
    namespace: "order:quote",
    limit: 30,
    windowSec: 5 * 60,
  });
  if (!guard.ok) return rateLimitResponse(guard, "报价请求较多，请稍后再试");

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const paymentMethod = body.paymentMethod === "usdt" ? "usdt" : "alipay";
  const issuedAt = Date.now();
  const exp = issuedAt + QUOTE_TTL_MS;
  const quoteId = makeId("PQ");
  const usdtNonce = paymentMethod === "usdt"
    ? await reserveUsdtNonce(quoteId, Math.ceil(QUOTE_TTL_MS / 1000) + 15 * 60)
    : 0;
  if (paymentMethod === "usdt" && !usdtNonce) {
    return Response.json({
      ok: false,
      error: "usdt_quote_unavailable",
      message: "USDT 精确付款金额生成失败，请稍后重试",
    }, { status: 503 });
  }
  const paymentAdjustment = paymentMethod === "alipay" ? generatePaymentAdjustment() : 0;
  return Response.json({
    ok: true,
    paymentAdjustment,
    usdtNonce,
    quoteToken: signPaymentQuote({ quoteId, paymentMethod, paymentAdjustment, usdtNonce, issuedAt, exp }),
    expiresAt: new Date(exp).toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
