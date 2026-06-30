import { getUsdtRate } from "../_utils.js";
import { getSettings } from "../_settings.js";

// GET /api/usdt-rate — 公开：美元兑人民币汇率（USDT 结算用）。
// 后台设了固定汇率则用固定值,否则每日自动。
export async function GET() {
  const settings = await getSettings();
  const rate = settings.usdt.rateOverride ? Number(settings.usdt.rateOverride) : await getUsdtRate();
  return Response.json({ ok: true, rate }, { headers: { "Cache-Control": "no-store" } });
}
