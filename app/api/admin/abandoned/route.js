// 后台「弃单召回」— 到了结算页但未完成下单的访客。仅超级管理员。
// 数据：/api/track 的 checkout_started 写入 lm:cart:v:<vid> + ZSET lm:cart:index；
// /api/order 成功后清除对应 vid。这里读取仍在索引里的（=未转化）记录。
import {
  adminSessionFromRequest, isRootAdminSession, validEmail,
  redisCmd, redisPipeline, formatBeijingTime, sendSimpleEmail,
} from "../../_utils.js";
import { buildRecoveryEmailHtml, buildRecoveryEmailText } from "./recovery-email.js";
import { getSettings } from "../../_settings.js";

export const runtime = "nodejs";
const CART_INDEX = "lm:cart:index";
const CART = "lm:cart:v:";
const BRAND_NAME = process.env.BRAND_NAME || "冒央会社";
const SITE_DOMAIN = process.env.SITE_DOMAIN || "www.liumeiti.vip";
const SITE_URL = process.env.SITE_URL || `https://${SITE_DOMAIN}`;

function unauth() { return Response.json({ ok: false, error: "unauthorized" }, { status: 401 }); }
function gate(request) { const s = adminSessionFromRequest(request); return s && isRootAdminSession(s) ? s : null; }
function flatToObj(v) {
  if (v && !Array.isArray(v) && typeof v === "object") return v;
  const o = {}; if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}
function row(id, h) {
  const ts = Number(h.ts || 0);
  let attr = null; try { attr = h.attr ? JSON.parse(h.attr) : null; } catch (e) {}
  return {
    id, email: h.email || "", services: h.services || "", amount: h.amount || "",
    status: h.status || "open", ip: h.ip || "",
    fromTool: !!(attr && attr.fromTool), source: attr ? (attr.utm_source || attr.referrer || (attr.fromTool ? "工具站" : "")) : "",
    ts, tsText: ts ? formatBeijingTime(ts) : "",
  };
}

export async function GET(request) {
  if (!gate(request)) return unauth();
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const total = Number((await redisCmd(["ZCARD", CART_INDEX])) || 0);
  const ids = (await redisCmd(["ZRANGE", CART_INDEX, String(offset), String(offset + limit - 1), "REV"])) || [];
  const rows = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = (await redisPipeline(chunk.map((id) => ["HGETALL", CART + id]))) || [];
    chunk.forEach((id, idx) => rows.push(row(id, flatToObj(res[idx] && res[idx].result))));
  }
  return Response.json({ ok: true, total, rows });
}

// POST — 单条操作：{id, action:"email"|"converted"}
export async function POST(request) {
  if (!gate(request)) return unauth();
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const id = String(body.id || "").replace(/[^a-f0-9]/g, "").slice(0, 32);
  const action = String(body.action || "");
  if (!id) return Response.json({ ok: false, error: "bad_id" }, { status: 400 });
  const ckey = CART + id;
  const h = flatToObj(await redisCmd(["HGETALL", ckey]));
  if (!h.ts) return Response.json({ ok: false, error: "not_found" }, { status: 404 });

  // 处理完从弃单索引移除该记录(召回过或已成交,不再显示在列表)
  async function removeRecord() {
    await redisCmd(["ZREM", CART_INDEX, id]);
    await redisCmd(["DEL", ckey]);
  }

  if (action === "converted") {
    await removeRecord();
    return Response.json({ ok: true, removed: true });
  }
  if (action === "email") {
    const to = (h.email || "").toLowerCase();
    if (!validEmail(to)) return Response.json({ ok: false, error: "no_email" }, { status: 400 });
    const services = h.services || "您挑选的服务";
    const locale = h.locale === "en" ? "en" : "zh";
    const en = locale === "en";
    // 品牌以站点设置为准
    const settings = await getSettings();
    const brandName = (en ? settings.brand.nameEn : settings.brand.name) || BRAND_NAME;
    const params = { services, amount: h.amount, brandName, siteDomain: SITE_DOMAIN, siteUrl: SITE_URL, support: settings.support, locale };
    const subject = en ? `Your ${brandName} order is one step away 🛒` : `您的订单还差一步就完成啦 🛒 · ${brandName}`;
    const html = buildRecoveryEmailHtml(params);
    const text = buildRecoveryEmailText(params);
    let sent = false;
    try { const r = await sendSimpleEmail({ to, subject, text, html, fromName: brandName, support: settings.support, locale }); sent = !!(r && (r.messageId || r.ok !== false)); }
    catch (e) { sent = false; }
    if (!sent) return Response.json({ ok: false, error: "send_failed" }, { status: 502 });
    // 召回邮件已发出 → 从列表移除
    await removeRecord();
    return Response.json({ ok: true, removed: true });
  }
  return Response.json({ ok: false, error: "bad_action" }, { status: 400 });
}

// DELETE — 批量：{ ids:[...] } 或 { olderThanDays:30 }
export async function DELETE(request) {
  if (!gate(request)) return unauth();
  let body = {};
  try { body = await request.json(); } catch (e) {}
  let ids = [];
  if (Array.isArray(body.ids) && body.ids.length) {
    ids = body.ids.map((x) => String(x)).filter((x) => /^[a-f0-9]{8,32}$/.test(x)).slice(0, 5000);
  } else if (body.olderThanDays) {
    const cutoff = Date.now() - Math.max(1, Number(body.olderThanDays)) * 86400000;
    ids = (await redisCmd(["ZRANGE", CART_INDEX, String(cutoff), "0", "BYSCORE", "REV", "LIMIT", "0", "3000"])) || [];
  }
  if (!ids.length) return Response.json({ ok: true, deleted: 0 });
  const cmds = [];
  for (const id of ids) cmds.push(["ZREM", CART_INDEX, id], ["DEL", CART + id]);
  for (let i = 0; i < cmds.length; i += 300) await redisPipeline(cmds.slice(i, i + 300));
  return Response.json({ ok: true, deleted: ids.length });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
