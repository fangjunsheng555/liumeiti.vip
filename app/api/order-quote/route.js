import {
  checkRateLimit,
  generatePaymentAdjustment,
  rateLimitResponse,
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

  const paymentAdjustment = generatePaymentAdjustment();
  const exp = Date.now() + QUOTE_TTL_MS;
  return Response.json({
    ok: true,
    paymentAdjustment,
    quoteToken: signPaymentQuote({ paymentAdjustment, exp }),
    expiresAt: new Date(exp).toISOString(),
  });
}

export async function GET() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
