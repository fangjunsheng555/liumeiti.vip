import {
  adminActorFromSession,
  adminSessionFromRequest,
  clean,
  deleteAdminActionLogEntries,
  getAdminActionLog,
  isRootAdminSession,
} from "../../_utils.js";

const ACTION_LABELS = {
  order_create: "系统创建订单",
  order_update: "更新订单",
  order_delete: "删除订单",
  order_batch_delete: "批量删除订单",
  order_batch_invalid: "批量标记无效",
  user_balance_adjust: "调整用户余额",
  user_ban: "封禁用户",
  user_unban: "解除封禁",
  user_delete: "删除用户",
  staff_create: "新增工作人员",
  staff_delete: "删除工作人员",
  customer_mail_send: "发送客服邮件",
  mail_log_delete: "删除邮件记录",
  redeem_code_create: "生成兑换码",
  redeem_code_void: "作废兑换码",
  redeem_code_delete: "删除兑换码",
  redeem_batch_void: "作废兑换码批次",
  redeem_batch_delete: "删除兑换码批次",
  redeem_code_send_email: "发送兑换码邮件",
  redeem_history_delete: "删除兑换记录",
  withdrawal_review: "审核提现",
  withdrawal_delete: "删除提现记录",
  balance_log_delete: "删除余额记录",
  action_log_delete: "删除操作记录",
};

function readableDetail(detail) {
  if (!detail || typeof detail !== "object") return "";
  const parts = [];
  if (detail.username) parts.push(`账号 ${detail.username}`);
  if (detail.role) parts.push(`角色 ${detail.role}`);
  if (detail.email) parts.push(`用户 ${detail.email}`);
  if (detail.amount) parts.push(`金额 ¥${Number(detail.amount).toFixed(2)}`);
  if (detail.balanceBefore !== undefined) parts.push(`调整前 ¥${Number(detail.balanceBefore || 0).toFixed(2)}`);
  if (detail.balanceAfter !== undefined) parts.push(`调整后 ¥${Number(detail.balanceAfter || 0).toFixed(2)}`);
  if (detail.paymentMethod) parts.push(`支付方式 ${detail.paymentMethod}`);
  if (detail.paidAmount) parts.push(`实付 ${detail.paidAmount}`);
  if (detail.itemCount) parts.push(`${detail.itemCount} 件商品`);
  if (detail.status) parts.push(`状态 ${detail.status}`);
  if (detail.from || detail.to) parts.push(`状态 ${detail.from || "-"} -> ${detail.to || "-"}`);
  if (detail.type) parts.push(`类型 ${detail.type}`);
  if (detail.quantity) parts.push(`数量 ${detail.quantity}`);
  if (detail.total) parts.push(`总数 ${detail.total}`);
  if (detail.changed) parts.push(`变更 ${detail.changed}`);
  if (detail.successCount) parts.push(`成功 ${detail.successCount}`);
  if (detail.deletedCount) parts.push(`删除 ${detail.deletedCount} 条`);
  if (detail.sentCount || detail.failedCount) parts.push(`发送 ${detail.sentCount || 0} 成功 / ${detail.failedCount || 0} 失败`);
  if (detail.orderIds?.length) parts.push(`订单 ${detail.orderIds.slice(0, 5).join(", ")}${detail.orderIds.length > 5 ? "..." : ""}`);
  if (detail.ids?.length) parts.push(`记录 ${detail.ids.slice(0, 5).join(", ")}${detail.ids.length > 5 ? "..." : ""}`);
  if (detail.codes?.length) parts.push(`兑换码 ${detail.codes.slice(0, 5).join(", ")}${detail.codes.length > 5 ? "..." : ""}`);
  if (detail.ip) parts.push(`IP ${detail.ip}`);
  if (detail.userAgent) parts.push(`UA ${String(detail.userAgent).slice(0, 80)}`);
  if (!parts.length) {
    Object.entries(detail).some(([key, value]) => {
      if (value === undefined || value === null || value === "") return false;
      const text = Array.isArray(value) ? value.slice(0, 5).join(", ") : String(value);
      parts.push(`${key}: ${text}${Array.isArray(value) && value.length > 5 ? "..." : ""}`);
      return parts.length >= 6;
    });
  }
  return parts.join("，");
}

function publicAction(entry) {
  const action = clean(entry?.action, 80);
  const detail = entry?.detail && typeof entry.detail === "object" ? entry.detail : {};
  return {
    id: clean(entry?.id, 80),
    action,
    actionLabel: ACTION_LABELS[action] || action || "后台操作",
    target: clean(entry?.target, 180),
    detail,
    detailText: readableDetail(detail),
    staffId: Number(entry?.staffId || 1),
    staffUsername: clean(entry?.staffUsername || "admin", 60),
    createdAt: entry?.createdAt || "",
    createdAtBeijing: entry?.createdAtBeijing || "",
  };
}

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const staffId = Number(url.searchParams.get("staffId") || 0);
  const q = clean(url.searchParams.get("q") || "", 80).toLowerCase();
  let actions = (await getAdminActionLog()).map(publicAction);
  if (Number.isFinite(staffId) && staffId > 0) actions = actions.filter((item) => item.staffId === staffId);
  if (q) {
    actions = actions.filter((item) =>
      item.actionLabel.toLowerCase().includes(q) ||
      item.target.toLowerCase().includes(q) ||
      item.staffUsername.toLowerCase().includes(q) ||
      item.detailText.toLowerCase().includes(q)
    );
  }
  return Response.json({ ok: true, actions });
}

export async function DELETE(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isRootAdminSession(session)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => clean(id, 120)).filter(Boolean) : [];
  const result = await deleteAdminActionLogEntries(ids, adminActorFromSession(session));
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 400 });
  const actions = (await getAdminActionLog()).map(publicAction);
  return Response.json({ ...result, actions });
}
