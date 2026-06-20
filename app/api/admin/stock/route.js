import {
  adminSessionFromRequest, adminPermissionProfile,
  adminActorFromRequest, pushAdminActionLog,
  getAiStockMap, setAiStock, AI_STOCK_PLAN_IDS,
} from "../../_utils.js";

const AI_PLAN_LABELS = {
  "gpt-plus": "GPT Plus",
  "gpt-pro": "GPT 5x Pro",
  "claude-pro": "Claude Pro",
  "claude-max": "Claude 5x Max",
};

// GET /api/admin/stock — 读取 AI 会员各规格库存（number | null=不限）
export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canManageStock) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const stock = await getAiStockMap();
  return Response.json({ ok: true, stock, planIds: AI_STOCK_PLAN_IDS, labels: AI_PLAN_LABELS });
}

// PATCH /api/admin/stock — 设置库存。body: { stock: { "gpt-plus": 50, "gpt-pro": "", ... } }
// 空字符串/null/"unlimited" → 不限（删除键）；整数 ≥0 → 设为该值
export async function PATCH(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!adminPermissionProfile(session).canManageStock) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const input = (body && typeof body.stock === "object" && body.stock) ? body.stock : (body || {});

  const updates = {};
  for (const id of AI_STOCK_PLAN_IDS) {
    if (!(id in input)) continue;
    const raw = input[id];
    if (raw === "" || raw == null || raw === "unlimited") {
      await setAiStock(id, "");
      updates[id] = null;
      continue;
    }
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 0) {
      return Response.json({ ok: false, error: "invalid_value", planId: id }, { status: 400 });
    }
    await setAiStock(id, n);
    updates[id] = n;
  }

  const actor = adminActorFromRequest(request);
  await pushAdminActionLog({ action: "ai_stock_update", actor, target: "ai-stock", detail: updates });
  const stock = await getAiStockMap();
  return Response.json({ ok: true, stock, updated: updates });
}
