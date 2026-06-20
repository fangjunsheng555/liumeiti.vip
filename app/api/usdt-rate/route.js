import { getUsdtRate } from "../_utils.js";

// GET /api/usdt-rate — 公开：返回当日美元兑人民币汇率（USDT 结算用，每日自动更新）
export async function GET() {
  const rate = await getUsdtRate();
  return Response.json({ ok: true, rate }, {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
