// 工具站 AI 配额覆盖 + 申请：共享存取层。被 chat/image 路由(读 override)、
// 用户申请接口、后台审批接口共用,保证读写同一份数据结构。
//
// 单一 Redis key `lm:tool:quota` = { overrides:[{type,email,daily,maxTokens,note,by,ts}], requests:[{id,email,type,requested,reason,status,createdAt,decidedAt,decidedBy}] }
// - type: "chat" | "image"
// - daily: 数字(每日条/张上限) | "unlimited"(不限额)
// - maxTokens(仅 chat): 数字 | "unlimited"(不限单次回复 token)
import { redisCmd, redisPipeline } from "../_utils.js";

const KEY = "lm:tool:quota";
export const UNLIMITED = "unlimited";

// ── 全站 AI 用量统计(给后台「全部用量」看板) ──
// 每用户累计次数,存 ZSET(member=邮箱, score=次数)便于排序/搜索:
//   chat = 对话条数, image = 生图张数。:all 为累计(无 TTL,即「历史」);:d:<北京日> 为当日(带 TTL)。
// 注意:历史只从本功能上线起累计(此前没有逐用户累计数据,无法回溯)。
export const AI_USE_CHAT_ALL = "lm:ai:use:chat:all";
export const AI_USE_IMG_ALL = "lm:ai:use:img:all";
function beijingDayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}
// 当日 ZSET key(chat/image),后台读「今日」与路由写入用同一函数,保证 key 一致。
export function aiUseDayKey(type) {
  return (type === "image" ? "lm:ai:use:img:d:" : "lm:ai:use:chat:d:") + beijingDayStr();
}
// 记录一次 AI 使用(chat 一条 / image 一张):累计 ZSET + 当日 ZSET。失败绝不影响主流程。
export async function recordAiUsage(type, email) {
  if (!email || (type !== "chat" && type !== "image")) return;
  const allKey = type === "image" ? AI_USE_IMG_ALL : AI_USE_CHAT_ALL;
  const dKey = aiUseDayKey(type);
  try {
    await redisPipeline([
      ["ZINCRBY", allKey, "1", email],
      ["ZINCRBY", dKey, "1", email],
      ["EXPIRE", dKey, "259200"], // 当日桶 3 天兜底过期(够后台看「今日」,跨天自动归零)
    ]);
  } catch (e) { /* 用量统计失败不影响对话/生图 */ }
}

export async function readQuota() {
  try {
    const raw = await redisCmd(["GET", KEY]);
    const d = raw ? JSON.parse(raw) : {};
    return {
      overrides: Array.isArray(d.overrides) ? d.overrides : [],
      requests: Array.isArray(d.requests) ? d.requests : [],
    };
  } catch (e) {
    return { overrides: [], requests: [] };
  }
}

export async function writeQuota(data) {
  const safe = {
    overrides: (Array.isArray(data.overrides) ? data.overrides : []).slice(-2000),
    requests: (Array.isArray(data.requests) ? data.requests : []).slice(-1000),
  };
  await redisCmd(["SET", KEY, JSON.stringify(safe)]);
  return safe;
}

// 取某用户某类型的覆盖(无则 null)。chat/image 路由每次调用。
export async function getOverride(type, email) {
  if (!email) return null;
  const { overrides } = await readQuota();
  return overrides.find((o) => o && o.type === type && o.email === email) || null;
}
