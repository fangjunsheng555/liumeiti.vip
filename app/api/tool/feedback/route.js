// Tool Maoyang — 用户「意见 / 建议」反馈，经主站现成 SMTP 发到运营邮箱。
// 开放提交（无需登录，降低门槛），靠 IP 速率限制 + 长度上限 + 蜜罐防滥用。
// 纯加性：复用现有 helpers，不改任何文件。CORS 由 middleware 覆盖 /api/tool/*。

import {
  clean, validEmail, checkRateLimit, rateLimitResponse,
  clientIpFromRequest, clientUserAgentFromRequest, formatBeijingTime, sendSimpleEmail,
} from "../../_utils.js";

export const runtime = "nodejs";

const TO = process.env.FEEDBACK_TO || "zunfromgb@gmail.com";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch (e) {}

  // 蜜罐：机器人填了隐藏字段就静默丢弃（假装成功）
  if (clean(body.hp, 100)) return Response.json({ ok: true });

  const content = clean(body.content, 2000);
  const email = clean(body.email, 200);
  const source = clean(body.source, 200);
  if (!content || content.length < 2) return Response.json({ ok: false, error: "empty" }, { status: 400 });
  if (email && !validEmail(email)) return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });

  const guard = await checkRateLimit(request, { namespace: "tool:feedback", limit: 5, windowSec: 3600 });
  if (!guard.ok) return rateLimitResponse(guard, "提交过于频繁，请稍后再试");

  const now = new Date();
  const text = [
    "【Tool Maoyang 用户建议】",
    "",
    content,
    "",
    "————————————",
    "联系邮箱：" + (email || "（未填写）"),
    "来源页：" + (source || "（未知）"),
    "提交时间：" + formatBeijingTime(now),
    "IP：" + clientIpFromRequest(request),
    "UA：" + clientUserAgentFromRequest(request),
  ].join("\n");
  const subject = "【工具站建议】" + content.replace(/\s+/g, " ").slice(0, 28);

  const r = await sendSimpleEmail({ to: TO, subject, text, category: "feedback" });
  if (!r || !r.ok) return Response.json({ ok: false, error: "send_failed" }, { status: 502 });
  return Response.json({ ok: true });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
