// 工具站 AI 配额覆盖 + 申请：共享存取层。被 chat/image 路由(读 override)、
// 用户申请接口、后台审批接口共用,保证读写同一份数据结构。
//
// 单一 Redis key `lm:tool:quota` = { overrides:[{type,email,daily,maxTokens,note,by,ts}], requests:[{id,email,type,requested,reason,status,createdAt,decidedAt,decidedBy}] }
// - type: "chat" | "image"
// - daily: 数字(每日条/张上限) | "unlimited"(不限额)
// - maxTokens(仅 chat): 数字 | "unlimited"(不限单次回复 token)
import { redisCmd } from "../_utils.js";

const KEY = "lm:tool:quota";
export const UNLIMITED = "unlimited";

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
