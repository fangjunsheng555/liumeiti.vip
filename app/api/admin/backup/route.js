// 全量业务数据备份导出(仅超管):订单/用户(含余额流水)/兑换码/提现/售后工单/
// 设置与目录覆盖/公告/日志 → 单个 JSON 下载。灾备用;访客埋点除外(量大低值,可重建)。
import {
  adminSessionFromRequest,
  isRootAdminSession,
  formatBeijingTime,
  getAllOrders,
  getAdminActionLog,
  getAdminBalanceLog,
  getAdminLoginLog,
  getAdminMailLog,
  getBalanceTxs,
  getUser,
  listAdminStaff,
  listAllUserEmails,
  listRedeemCodeBatches,
  listRedeemCodes,
  listWithdrawals,
  pushAdminActionLog,
  redisCmd,
} from "../../_utils.js";

export const runtime = "nodejs";
export const maxDuration = 60;

async function collectUsers() {
  const emails = await listAllUserEmails();
  const users = [];
  for (const email of emails) {
    const user = await getUser(email);
    if (!user) continue;
    const balanceTxs = await getBalanceTxs(email).catch(() => []);
    users.push({ email, ...user, balanceTxs });
  }
  return users;
}

async function collectAfterSalesTickets() {
  // 直接按索引全量拉取(store 的列表 API 面向分页,备份需要完整集)。
  const ids = await redisCmd(["ZREVRANGE", "liumeiti:after-sales:index", "0", "-1"]);
  const tickets = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const raw = await redisCmd(["GET", "liumeiti:after-sales:record:" + String(id).toUpperCase()]);
    if (!raw) continue;
    try { tickets.push(typeof raw === "object" ? raw : JSON.parse(raw)); } catch (e) {}
  }
  return tickets;
}

async function collectRawJson(key) {
  const raw = await redisCmd(["GET", key]);
  if (!raw) return null;
  try { return typeof raw === "object" ? raw : JSON.parse(raw); } catch (e) { return raw; }
}

export async function GET(request) {
  const session = adminSessionFromRequest(request);
  if (!session || !isRootAdminSession(session)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  const [
    orders, users, redeemCodes, redeemBatches, withdrawals, afterSalesTickets,
    settingsOverrides, catalogOverrides, announcePosts, announcement,
    staff, actionLog, balanceLog, loginLog, mailLog,
  ] = await Promise.all([
    getAllOrders(),
    collectUsers(),
    listRedeemCodes(),
    listRedeemCodeBatches(),
    listWithdrawals(),
    collectAfterSalesTickets(),
    collectRawJson("lm:settings"),
    collectRawJson("lm:catalog:overrides"),
    collectRawJson("lm:announce:posts"),
    collectRawJson("lm:announce"),
    listAdminStaff(),
    getAdminActionLog(),
    getAdminBalanceLog(),
    getAdminLoginLog(500),
    getAdminMailLog(),
  ]);

  const backup = {
    site: "liumeiti.vip",
    version: 1,
    generatedAt: startedAt.toISOString(),
    generatedAtBeijing: formatBeijingTime(startedAt),
    counts: {
      orders: orders.length,
      users: users.length,
      redeemCodes: redeemCodes.length,
      redeemBatches: redeemBatches.length,
      withdrawals: withdrawals.length,
      afterSalesTickets: afterSalesTickets.length,
      staff: staff.length,
    },
    data: {
      orders,
      users,
      redeemCodes,
      redeemBatches,
      withdrawals,
      afterSalesTickets,
      settingsOverrides,
      catalogOverrides,
      announcePosts,
      announcement,
      staff,
      actionLog,
      balanceLog,
      loginLog,
      mailLog,
    },
  };

  await pushAdminActionLog({
    action: "backup_export",
    actor: { staffId: Number(session.staffId || 1), staffUsername: session.staffUsername || "admin" },
    target: "backup",
    detail: backup.counts,
  }).catch(() => {});

  const stamp = backup.generatedAtBeijing.slice(0, 19).replace(/[: ]/g, "-");
  return new Response(JSON.stringify(backup, null, 1), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="liumeiti-backup-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
