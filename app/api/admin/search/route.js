// 后台全局搜索(⌘K)。一框搜订单 / 用户 / 兑换码 / 邮箱。按角色权限返回。
import {
  adminSessionFromRequest, adminPermissionProfile,
  getAllOrders, listAllUserEmails, getUser, listRedeemCodes,
} from "../../_utils.js";

export const runtime = "nodejs";

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const perms = adminPermissionProfile(session);
  const q = String(new URL(request.url).searchParams.get("q") || "").trim().toLowerCase();
  if (q.length < 2) return Response.json({ ok: true, orders: [], users: [], codes: [] });

  const statusLabel = { awaiting_quote: "待报价", pending_payment: "待付款", quote_expired: "报价已失效", received: "未完成", completed: "已完成", invalid: "无效" };

  // 订单(所有可看订单的角色)
  const allOrders = await getAllOrders();
  const orders = allOrders
    .filter((o) => [o.orderId, o.email, o.contact, o.serviceLabel, o.platformUrl, o.productPrice].join(" ").toLowerCase().includes(q))
    .slice(0, 6)
    .map((o) => ({
      orderId: o.orderId || "", email: o.email || "",
      serviceLabel: o.serviceLabel || (Array.isArray(o.items) ? o.items.map((i) => i.label).join(" + ") : ""),
      status: o.status || "received", statusLabel: statusLabel[o.status] || o.status || "",
      createdAtBeijing: o.createdAtBeijing || "",
    }));

  // 用户(需 canViewUsers)
  let users = [];
  if (perms.canViewUsers) {
    const emails = await listAllUserEmails();
    const records = (await Promise.all(emails.map((e) => getUser(e)))).filter(Boolean);
    users = records
      .filter((u) => `${u.email || ""} ${u.username || ""}`.toLowerCase().includes(q))
      .slice(0, 6)
      .map((u) => ({ email: u.email || "", username: u.username || "", balance: Number(u.balance || 0), banned: !!u.banned }));
  }

  // 兑换码(需 canViewCodes)
  let codes = [];
  if (perms.canViewCodes) {
    const all = await listRedeemCodes();
    codes = (Array.isArray(all) ? all : [])
      .filter((c) => `${c.code || ""} ${c.usedBy || ""} ${c.email || ""}`.toLowerCase().includes(q))
      .slice(0, 6)
      .map((c) => ({ code: c.code || "", status: c.status || "", typeLabel: c.typeLabel || c.type || "", usedBy: c.usedBy || "" }));
  }

  return Response.json({ ok: true, orders, users, codes });
}
