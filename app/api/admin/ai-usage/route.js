// 后台「全部用量」— 全站所有用户的 AI 用量(对话条数 / 生图张数,今日 + 历史)。仅超级管理员。
// 数据来源 = recordAiUsage 写入的 ZSET(见 app/api/tool/_quota.js):
//   lm:ai:use:chat:all / lm:ai:use:img:all  → 历史累计(member=邮箱, score=次数)
//   lm:ai:use:chat:d:<北京日> / lm:ai:use:img:d:<北京日> → 当日
// GET ?period=today|all&q=<邮箱关键词>&offset=0&limit=50 → { items, totalUsers, summary }
// 注:历史只从本功能上线起累计,无法回溯此前用量。
import { adminSessionFromRequest, isRootAdminSession, redisCmd } from "../../_utils.js";
import { AI_USE_CHAT_ALL, AI_USE_IMG_ALL, aiUseDayKey } from "../../tool/_quota.js";

export const runtime = "nodejs";

function gate(request) {
  const s = adminSessionFromRequest(request);
  return s && isRootAdminSession(s) ? s : null;
}

// ZSET 全量读成 {邮箱: 次数}。ZRANGE ... WITHSCORES 返回 [member, score, member, score, ...]。
async function zsetMap(key) {
  const out = {};
  try {
    const arr = await redisCmd(["ZRANGE", key, "0", "-1", "WITHSCORES"]);
    if (Array.isArray(arr)) {
      for (let i = 0; i + 1 < arr.length; i += 2) {
        const m = String(arr[i] || "");
        const s = Number(arr[i + 1]) || 0;
        if (m) out[m] = s;
      }
    }
  } catch (e) { /* 读不到当空处理 */ }
  return out;
}

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const period = url.searchParams.get("period") === "today" ? "today" : "all";
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));

  // 并发读 4 个 ZSET:历史累计 + 当日
  const [chatAll, imgAll, chatDay, imgDay] = await Promise.all([
    zsetMap(AI_USE_CHAT_ALL),
    zsetMap(AI_USE_IMG_ALL),
    zsetMap(aiUseDayKey("chat")),
    zsetMap(aiUseDayKey("image")),
  ]);

  // 合并所有出现过的用户(任一桶里有就算)
  const emails = new Set([
    ...Object.keys(chatAll), ...Object.keys(imgAll),
    ...Object.keys(chatDay), ...Object.keys(imgDay),
  ]);

  let rows = [];
  for (const email of emails) {
    rows.push({
      email,
      chatToday: chatDay[email] || 0,
      imgToday: imgDay[email] || 0,
      chatTotal: chatAll[email] || 0,
      imgTotal: imgAll[email] || 0,
    });
  }

  // 汇总(搜索前的全站合计,给「全站累计」展示)
  const grand = rows.reduce((s, r) => ({
    users: s.users + 1,
    chatToday: s.chatToday + r.chatToday, imgToday: s.imgToday + r.imgToday,
    chatTotal: s.chatTotal + r.chatTotal, imgTotal: s.imgTotal + r.imgTotal,
  }), { users: 0, chatToday: 0, imgToday: 0, chatTotal: 0, imgTotal: 0 });

  if (q) rows = rows.filter((r) => r.email.toLowerCase().includes(q));

  // 从多到少:按所选周期的「对话+生图」总活跃排序,平手再按历史总量
  const periodTotal = (r) => (period === "today" ? r.chatToday + r.imgToday : r.chatTotal + r.imgTotal);
  rows.sort((a, b) => periodTotal(b) - periodTotal(a) || (b.chatTotal + b.imgTotal) - (a.chatTotal + a.imgTotal));

  const matched = rows.length;
  const items = rows.slice(offset, offset + limit);

  return Response.json({
    ok: true,
    period,
    matched,             // 当前搜索命中的用户数
    grand,               // 全站合计(不受搜索影响)
    items,
    hasMore: offset + items.length < matched,
    generatedAt: Date.now(),
  });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
