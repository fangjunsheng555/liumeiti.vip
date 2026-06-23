// 站内公告 — 公开读取（前端 banner 用）。内容由后台 /api/admin/announcement 设置。
// 存 Redis：lm:announce = JSON { id, text, link, active, updatedAt }
import { redisCmd } from "../_utils.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    const raw = await redisCmd(["GET", "lm:announce"]);
    if (raw) {
      const a = JSON.parse(raw);
      if (a && a.active && a.text) {
        return Response.json(
          { ok: true, id: a.id || 0, text: String(a.text).slice(0, 300), link: String(a.link || "").slice(0, 300) },
          { headers: { "cache-control": "public, max-age=60" } }
        );
      }
    }
  } catch (e) {}
  return Response.json({ ok: true, id: 0, text: "" }, { headers: { "cache-control": "public, max-age=60" } });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
