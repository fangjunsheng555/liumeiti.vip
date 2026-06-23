// 站内公告 — 公开读取（前端 banner 用）。内容由后台 /api/admin/announcement 设置。
// 存 Redis：lm:announce = JSON { id, text, textEn, link, active, updatedAt }
import { redisCmd } from "../_utils.js";

export const runtime = "nodejs";

// 只放行 http(s) 绝对链接或站内相对链接，过滤 javascript:/data: 等危险协议。
function safeLink(v) {
  const s = String(v || "").slice(0, 300).trim();
  if (!s) return "";
  if (s.startsWith("/")) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return "";
}

export async function GET() {
  try {
    const raw = await redisCmd(["GET", "lm:announce"]);
    if (raw) {
      const a = JSON.parse(raw);
      if (a && a.active && a.text) {
        return Response.json(
          {
            ok: true, id: a.id || 0,
            text: String(a.text).slice(0, 300),
            textEn: String(a.textEn || "").slice(0, 300),
            link: safeLink(a.link),
          },
          { headers: { "cache-control": "public, max-age=60" } }
        );
      }
    }
  } catch (e) {}
  return Response.json({ ok: true, id: 0, text: "", textEn: "" }, { headers: { "cache-control": "public, max-age=60" } });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
