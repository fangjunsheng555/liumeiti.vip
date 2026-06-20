import { getAiSoldOutMap } from "../_utils.js";

// GET /api/ai-stock — 公开：仅返回各 AI 规格是否售罄（不暴露剩余数量）
export async function GET() {
  const soldOut = await getAiSoldOutMap();
  return Response.json({ ok: true, soldOut }, {
    headers: { "Cache-Control": "no-store" },
  });
}
