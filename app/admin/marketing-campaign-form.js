const MIN_SCHEDULE_AHEAD_MS = 5 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

export function localDateTimeToIso(value) {
  if (!String(value || "").trim()) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

export function validateMarketingCampaignDates({ scheduledAt = "", endsAt = "" } = {}, now = Date.now()) {
  const scheduledIso = localDateTimeToIso(scheduledAt);
  const endsAtIso = localDateTimeToIso(endsAt);
  const scheduledMs = scheduledIso ? Date.parse(scheduledIso) : NaN;
  const endsAtMs = endsAtIso ? Date.parse(endsAtIso) : 0;
  if (!scheduledIso) return { ok: false, error: "请选择有效的计划发送时间", scheduledIso: "", endsAtIso };
  if (scheduledMs < Number(now) + MIN_SCHEDULE_AHEAD_MS) {
    return { ok: false, error: "计划发送时间至少需要提前 5 分钟", scheduledIso, endsAtIso };
  }
  if (scheduledMs > Number(now) + MAX_SCHEDULE_AHEAD_MS) {
    return { ok: false, error: "计划发送时间不能超过 30 天", scheduledIso, endsAtIso };
  }
  if (endsAt && !endsAtIso) return { ok: false, error: "最晚派发时间格式无效", scheduledIso, endsAtIso: "" };
  if (endsAtMs && endsAtMs <= Number(now)) return { ok: false, error: "最晚派发时间必须晚于当前时间", scheduledIso, endsAtIso };
  if (endsAtMs && endsAtMs <= scheduledMs) return { ok: false, error: "最晚派发时间必须晚于开始排期时间", scheduledIso, endsAtIso };
  return { ok: true, error: "", scheduledIso, endsAtIso };
}

export const marketingCampaignDateLimits = {
  MIN_SCHEDULE_AHEAD_MS,
  MAX_SCHEDULE_AHEAD_MS,
};
