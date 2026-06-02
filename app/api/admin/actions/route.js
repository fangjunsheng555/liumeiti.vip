import {
  adminActorFromSession,
  adminSessionFromRequest,
  clean,
  deleteAdminActionLogEntries,
  getAdminActionLog,
  isRootAdminSession,
} from "../../_utils.js";

const ACTION_LABELS = {
  admin_login: "后台登录",
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
  redeem_batch_create: "创建兑换码批次",
  redeem_batch_void: "作废兑换码批次",
  redeem_batch_delete: "删除兑换码批次",
  redeem_code_send_email: "发送兑换码邮件",
  redeem_history_delete: "删除兑换记录",
  withdrawal_review: "审核提现",
  withdrawal_delete: "删除提现记录",
  balance_log_delete: "删除余额记录",
  action_log_delete: "删除操作记录",
};

const DETAIL_LABELS = {
  username: "账号",
  role: "角色",
  email: "用户邮箱",
  to: "收件邮箱",
  amount: "金额",
  balanceBefore: "调整前",
  balanceAfter: "调整后",
  paymentMethod: "支付方式",
  paidAmount: "实付金额",
  itemCount: "商品数量",
  status: "状态",
  from: "原状态",
  type: "类型",
  quantity: "数量",
  total: "总数",
  changed: "变更项",
  successCount: "成功数",
  deletedCount: "删除条数",
  sentCount: "发送成功",
  failedCount: "发送失败",
  orderId: "订单号",
  batchId: "批次号",
  logId: "记录号",
  ip: "登录 IP",
  userAgent: "浏览器",
};

const ROLE_LABELS = {
  owner: "主账号",
  operator: "运营",
  support: "客服",
  finance: "财务",
};

const TYPE_LABELS = {
  service: "服务码",
  balance: "余额码",
};

const STATUS_LABELS = {
  received: "待处理",
  completed: "已完成",
  invalid: "无效",
  active: "可用",
  used: "已使用",
  void: "已作废",
  pending: "待审核",
  processing: "处理中",
  success: "成功",
  failed: "失败",
};

function browserLabel(userAgent = "") {
  const ua = String(userAgent || "");
  if (!ua) return "";
  const os = /Windows/i.test(ua) ? "Windows" : /Macintosh|Mac OS/i.test(ua) ? "macOS" : /iPhone|iPad/i.test(ua) ? "iOS" : /Android/i.test(ua) ? "Android" : "";
  const browser = /Edg\//i.test(ua) ? "Edge" : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : /Firefox\//i.test(ua) ? "Firefox" : "浏览器";
  return [os, browser].filter(Boolean).join(" · ") || ua.slice(0, 80);
}

function readableValue(key, value) {
  if (value === undefined || value === null || value === "") return "";
  if (key === "amount" || key === "balanceBefore" || key === "balanceAfter" || key === "paidAmount") {
    return `¥${Number(value || 0).toFixed(2)}`;
  }
  if (key === "role") return ROLE_LABELS[value] || value;
  if (key === "type") return TYPE_LABELS[value] || value;
  if (key === "status" || key === "from" || key === "to") return STATUS_LABELS[value] || value;
  if (key === "userAgent") return browserLabel(value);
  if (Array.isArray(value)) return `${value.slice(0, 5).join(", ")}${value.length > 5 ? "..." : ""}`;
  return String(value);
}

function readableFallbackAction(action) {
  if (!action) return "后台操作";
  return ACTION_LABELS[action] || action
    .split("_")
    .filter(Boolean)
    .map((part) => DETAIL_LABELS[part] || TYPE_LABELS[part] || part)
    .join(" ");
}

function readableTarget(target = "") {
  const text = clean(target, 180);
  if (!text || text === "system") return "系统";
  const [kind, ...rest] = text.split(":");
  const value = rest.join(":");
  if (!value) return text;
  const labels = {
    staff: "工作人员",
    user: "用户",
    order: "订单",
    "redeem-batch": "兑换码批次",
    "redeem-code": "兑换码",
    "redeem-history": "兑换记录",
    mail: "邮件记录",
    withdrawal: "提现记录",
    "balance-log": "余额记录",
    "action-log": "操作记录",
  };
  return labels[kind] ? `${labels[kind]} ${value}` : text;
}

function readableDetail(detail) {
  if (!detail || typeof detail !== "object") return "";
  const parts = [];
  const preferredKeys = [
    "username", "role", "email", "to", "amount", "balanceBefore", "balanceAfter",
    "paymentMethod", "paidAmount", "itemCount", "status", "from", "type",
    "quantity", "total", "changed", "successCount", "deletedCount",
    "batchId", "orderId", "logId", "ip", "userAgent",
  ];
  preferredKeys.forEach((key) => {
    if (!(key in detail)) return;
    const value = readableValue(key, detail[key]);
    if (!value) return;
    if (key === "from" || key === "to") return;
    parts.push(`${DETAIL_LABELS[key] || key} ${value}`);
  });
  if (detail.from || detail.to) {
    parts.push(`状态变更 ${readableValue("from", detail.from) || "-"} → ${readableValue("to", detail.to) || "-"}`);
  }
  if (detail.sentCount || detail.failedCount) {
    parts.push(`发送结果 ${detail.sentCount || 0} 成功 / ${detail.failedCount || 0} 失败`);
  }
  if (detail.orderIds?.length) parts.push(`订单 ${detail.orderIds.slice(0, 5).join(", ")}${detail.orderIds.length > 5 ? "..." : ""}`);
  if (detail.ids?.length) parts.push(`记录 ${detail.ids.slice(0, 5).join(", ")}${detail.ids.length > 5 ? "..." : ""}`);
  if (detail.codes?.length) parts.push(`兑换码 ${detail.codes.slice(0, 5).join(", ")}${detail.codes.length > 5 ? "..." : ""}`);
  if (!parts.length) {
    Object.entries(detail).some(([key, value]) => {
      if (value === undefined || value === null || value === "") return false;
      const text = readableValue(key, value);
      parts.push(`${DETAIL_LABELS[key] || key} ${text}`);
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
    actionLabel: readableFallbackAction(action),
    target: clean(entry?.target, 180),
    targetLabel: readableTarget(entry?.target),
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
      item.targetLabel.toLowerCase().includes(q) ||
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
