// 后台「弃单召回」— 到了结算页但未完成下单的访客。仅超级管理员。
// 数据：/api/track 的 checkout_started 写入 lm:cart:v:<vid> + ZSET lm:cart:index；
// /api/order 成功后清除对应 vid。这里读取仍在索引里的（=未转化）记录。
import {
  adminSessionFromRequest, isRootAdminSession, validEmail,
  redisCmd, redisPipeline, formatBeijingTime, sendSimpleEmail,
} from "../../_utils.js";

export const runtime = "nodejs";
const CART_INDEX = "lm:cart:index";
const CART = "lm:cart:v:";
const SITE = "https://www.liumeiti.vip";

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

  if (action === "converted") {
    await redisCmd(["HSET", ckey, "status", "converted"]);
    return Response.json({ ok: true });
  }
  if (action === "email") {
    const to = (h.email || "").toLowerCase();
    if (!validEmail(to)) return Response.json({ ok: false, error: "no_email" }, { status: 400 });
    const services = h.services || "您挑选的服务";
    const subject = "您在 liumeiti.vip 的订单还没完成 🛒";
    const text = `您好，\n\n看到您挑选了「${services}」但还没完成下单。现在回来即可继续：${SITE}/\n\n如有任何疑问，随时联系客服，我们很乐意帮您。\n\n— liumeiti.vip`;
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#1d1d1f">
      <h2 style="font-size:19px">您的订单还差一步 🛒</h2>
      <p style="color:#555;line-height:1.7">看到您挑选了 <b>${services}</b> 但还没完成下单。现在回来即可继续：</p>
      <p style="margin:22px 0"><a href="${SITE}/" style="background:#0f766e;color:#fff;text-decoration:none;padding:11px 26px;border-radius:10px;font-weight:600">回去完成下单 →</a></p>
      <p style="color:#888;font-size:13px;line-height:1.7">如有任何疑问，随时联系客服，我们很乐意帮您。<br>— liumeiti.vip</p>
    </div>`;
    let sent = false;
    try { const r = await sendSimpleEmail({ to, subject, text, html, fromName: "liumeiti.vip" }); sent = !!(r && (r.messageId || r.ok !== false)); }
    catch (e) { sent = false; }
    if (!sent) return Response.json({ ok: false, error: "send_failed" }, { status: 502 });
    await redisCmd(["HSET", ckey, "status", "contacted", "contactedAt", String(Date.now())]);
    return Response.json({ ok: true });
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
