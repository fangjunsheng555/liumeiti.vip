import {
  clean, getRedeemCodePublic,
  checkRedeemRateLimit, recordRedeemRateFailure, clearRedeemRateLimit, redeemRateLimitMessage,
} from "../_utils.js";

export async function GET(request) {
  const guard = await checkRedeemRateLimit(request);
  if (!guard.ok) {
    return Response.json({
      ok: false,
      error: "too_many_attempts",
      message: redeemRateLimitMessage(guard.retryAfter),
      retryAfter: guard.retryAfter,
    }, { status: 429, headers: { "Retry-After": String(guard.retryAfter || 300) } });
  }
  const url = new URL(request.url);
  const result = await getRedeemCodePublic(url.searchParams.get("code") || "");
  if (!result.ok || result.status !== "active") {
    await recordRedeemRateFailure(guard);
    return Response.json({ ok: false, error: clean(result.error || "code_unavailable", 80), message: "兑换码不存在" }, { status: 404 });
  }
  await clearRedeemRateLimit(guard);
  return Response.json(result);
}
