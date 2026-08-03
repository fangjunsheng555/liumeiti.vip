import {
  adminSessionFromRequest, adminPermissionProfile,
  adminActorFromRequest, pushAdminActionLog,
  getAiStockMap, AI_STOCK_PLAN_IDS,
} from "../../_utils.js";
import { setStockAndMaybeEnqueueRestock } from "../../_push.js";
import { normalizeStockValue } from "../../_stock-input.js";

export { normalizeStockValue } from "../../_stock-input.js";

const AI_PLAN_LABELS = {
  "gpt-plus": "GPT Plus",
  "gpt-pro": "GPT 5x Pro",
  "gpt-20x-pro": "GPT 20x Pro",
  "claude-pro": "Claude Pro",
  "claude-max": "Claude 5x Max",
  "claude-20x-max": "Claude 20x Max",
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
  const failures = [];
  const operationPrefix = `ai-stock:${Date.now().toString(36)}`;
  for (const id of AI_STOCK_PLAN_IDS) {
    if (!(id in input)) continue;
    const raw = input[id];
    const normalized = normalizeStockValue(raw);
    if (!normalized.ok) {
      return Response.json({ ok: false, error: "invalid_value", planId: id }, { status: 400 });
    }
    if (normalized.value === "") {
      const result = await setStockAndMaybeEnqueueRestock("ai", id, "", `${operationPrefix}:${id}`, {
        serviceLabelZh: "AI 会员",
        serviceLabelEn: "AI membership",
        planLabelZh: AI_PLAN_LABELS[id] || id,
        planLabelEn: AI_PLAN_LABELS[id] || id,
      });
      if (result.ok) updates[id] = null;
      else failures.push({ planId: id, error: result.error || "stock_update_failed" });
      continue;
    }
    const n = normalized.value;
    const result = await setStockAndMaybeEnqueueRestock("ai", id, n, `${operationPrefix}:${id}`, {
      serviceLabelZh: "AI 会员",
      serviceLabelEn: "AI membership",
      planLabelZh: AI_PLAN_LABELS[id] || id,
      planLabelEn: AI_PLAN_LABELS[id] || id,
    });
    if (result.ok) updates[id] = n;
    else failures.push({ planId: id, error: result.error || "stock_update_failed" });
  }

  const actor = adminActorFromRequest(request);
  await pushAdminActionLog({ action: "ai_stock_update", actor, target: "ai-stock", detail: { updates, failures } });
  const stock = await getAiStockMap();
  if (failures.length) {
    return Response.json({
      ok: false,
      error: "stock_update_failed",
      partial: Object.keys(updates).length > 0,
      updated: updates,
      failed: failures,
      stock,
    }, { status: 503 });
  }
  return Response.json({ ok: true, stock, updated: updates });
}
