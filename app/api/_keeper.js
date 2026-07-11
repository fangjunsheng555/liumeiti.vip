// 流量搭车维护 tick:高频公共路由(/api/track 信标)响应后异步触发,
// 让「USDT 链上自动确认」「服务到期提醒」等后台任务在没人开管理后台、
// 也没配外部 cron 时照样运转(只要站点有任何访问)。
// 双保险:外部 cron / 后台轮询仍可直接打 /api/admin/usdt-check(CRON_SECRET)。
// 成本控制:每个信标只多 1 条 SET NX 命令;窗口内只有第一个请求真正执行。
import { redisCmd, redisConfig } from "./_utils.js";

const USDT_TICK_LOCK = "lm:keeper:usdt-tick";
const USDT_TICK_INTERVAL_SEC = 120;          // 链上扫描至多每 2 分钟一次
const RENEWAL_TICK_LOCK = "lm:keeper:renewal-tick";
const RENEWAL_TICK_INTERVAL_SEC = 6 * 60 * 60; // 到期提醒扫描至多每 6 小时一次

async function usdtTick() {
  const acquired = await redisCmd(["SET", USDT_TICK_LOCK, "1", "NX", "EX", String(USDT_TICK_INTERVAL_SEC)]);
  if (acquired !== "OK") return;
  const { getSettings } = await import("./_settings.js");
  const { confirmPendingUsdtPayments } = await import("./_usdt-confirm.js");
  const settings = await getSettings();
  // 未开启 autoConfirm 时 confirmPendingUsdtPayments 直接返回 disabled,零链上请求。
  await confirmPendingUsdtPayments({ settings, actor: { staffId: 0, staffUsername: "keeper" } });
}

async function renewalTick() {
  const acquired = await redisCmd(["SET", RENEWAL_TICK_LOCK, "1", "NX", "EX", String(RENEWAL_TICK_INTERVAL_SEC)]);
  if (acquired !== "OK") return;
  const { sendDueRenewalReminders } = await import("./_renewal.js");
  await sendDueRenewalReminders();
}

export async function runMaintenanceTick() {
  if (!redisConfig()) return;
  try { await usdtTick(); } catch (e) {}
  try { await renewalTick(); } catch (e) {}
}
