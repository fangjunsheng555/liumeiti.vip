// 订单服务到期计算(纯函数,前后端共用,零依赖)。
// 到期 = 订单完成时间(completedAt,缺失回退 createdAt) + 周期时长。
// 周期从 item.cycle 文案稳健解析(目录文案可后台改,按「数字+单位」识别);
// 一次性/按单/人工报价类无时长 → 不计到期。历史订单即时生效,无需回填存储。

const CN_NUM = { "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12 };

function parseCount(raw) {
  if (raw == null || raw === "") return 1; // 「年付」「月付」= 1
  const s = String(raw);
  if (/^\d+$/.test(s)) return Number(s);
  return CN_NUM[s] ?? null;
}

// 解析周期文案 → { months } 或 { days } 或 null(无时长)。
export function parseCycleDuration(cycle) {
  const s = String(cycle || "").trim();
  if (!s) return null;
  if (/次|按单|报价|一次性|永久|终身|lifetime|permanent|one[- ]?time/i.test(s)) return null;
  if (/半年/.test(s)) return { months: 6 };
  const NUM = "(\\d+|[一两二三四五六七八九十]{1,2})?";
  let m = s.match(new RegExp(NUM + "\\s*个?\\s*(?:年|years?)", "i"));
  if (m) { const n = parseCount(m[1]); return n ? { months: n * 12 } : null; }
  m = s.match(new RegExp(NUM + "\\s*个?\\s*(?:月|months?)", "i"));
  if (m) { const n = parseCount(m[1]); return n ? { months: n } : null; }
  if (/季/.test(s)) return { months: 3 };
  m = s.match(new RegExp(NUM + "\\s*(?:周|weeks?)", "i"));
  if (m) { const n = parseCount(m[1]); return n ? { days: n * 7 } : null; }
  m = s.match(new RegExp(NUM + "\\s*(?:天|日|days?)", "i"));
  if (m) { const n = parseCount(m[1]); return n ? { days: n } : null; }
  return null;
}

// 加日历月(日期钳制:1/31 + 1月 → 2/28)。
function addMonths(ts, months) {
  const d = new Date(ts);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const maxDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, maxDay));
  return d.getTime();
}

function orderItemsOf(order) {
  if (Array.isArray(order?.items) && order.items.length) return order.items;
  if (!order) return [];
  return [{ service: order.service || "", label: order.serviceLabel || "", cycle: order.cycle || "", plan: order.plan || order.rocketPlan || "" }];
}

// 订单到期摘要:最早到期项为准。仅 completed 订单有意义;无可解析周期 → null。
// 返回 { expiresAt(ISO), daysLeft(可负), expired, items:[{service, label, plan, cycle, expiresAt, daysLeft}] }
export function orderExpirySummary(order, now = Date.now()) {
  if (!order || (order.status || "") !== "completed") return null;
  const anchor = new Date(order.completedAt || order.createdAt || 0).getTime();
  if (!Number.isFinite(anchor) || anchor <= 0) return null;
  const items = [];
  for (const item of orderItemsOf(order)) {
    const duration = parseCycleDuration(item?.cycle);
    if (!duration) continue;
    const ts = duration.months ? addMonths(anchor, duration.months) : anchor + duration.days * 86400000;
    items.push({
      service: item.service || "",
      label: item.label || "",
      plan: item.plan || item.rocketPlan || "",
      cycle: item.cycle || "",
      expiresAt: new Date(ts).toISOString(),
      daysLeft: Math.ceil((ts - now) / 86400000),
    });
  }
  if (!items.length) return null;
  const earliest = items.reduce((min, item) => (item.daysLeft < min.daysLeft ? item : min), items[0]);
  return {
    expiresAt: earliest.expiresAt,
    daysLeft: earliest.daysLeft,
    expired: earliest.daysLeft < 0,
    items,
  };
}

// 一键续费链接:预填结算页(?items=…&<key>Plan=…,结算页现有机制直接识别)。
// 排除报价类(proxy-pay)与无周期项;无有效项返回空串。
export function renewalCheckoutPath(order) {
  const seen = new Set();
  const keys = [];
  const params = [];
  for (const item of orderItemsOf(order)) {
    const service = String(item?.service || "").trim();
    if (!service || service === "proxy-pay" || seen.has(service)) continue;
    if (!parseCycleDuration(item?.cycle)) continue;
    seen.add(service);
    keys.push(service);
    const plan = String(item?.plan || item?.rocketPlan || "").trim();
    if (plan) params.push(`${encodeURIComponent(service)}Plan=${encodeURIComponent(plan)}`);
  }
  if (!keys.length) return "";
  return `/checkout?items=${keys.map(encodeURIComponent).join(",")}${params.length ? "&" + params.join("&") : ""}`;
}
