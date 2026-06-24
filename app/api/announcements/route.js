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

// 顶栏公告条 = 轮播多条(只标题):
//  ① 后台「站内公告」单条 banner（lm:announce，active）→ 点击跳后台预设链接
//  ② 公告中心标记「在站内公告轮播」的已发布公告（lm:announce:posts，inBar）→ 点击进 /announcements
// 返回 { ok, items:[{id,text,textEn,link,kind}], 以及兼容旧单条字段 }。
export async function GET() {
  const items = [];
  let legacy = { id: 0, text: "", textEn: "" };

  // ① 站内公告 banner
  try {
    const raw = await redisCmd(["GET", "lm:announce"]);
    if (raw) {
      const a = JSON.parse(raw);
      if (a && a.active && a.text) {
        const item = {
          id: "bar:" + (a.id || 0),
          text: String(a.text).slice(0, 300),
          textEn: String(a.textEn || "").slice(0, 300),
          link: safeLink(a.link),
          kind: "bar",
        };
        items.push(item);
        legacy = { id: a.id || 0, text: item.text, textEn: item.textEn, link: item.link };
      }
    }
  } catch (e) {}

  // ② 公告中心标记轮播的公告(只取标题)
  try {
    const rawPosts = await redisCmd(["GET", "lm:announce:posts"]);
    if (rawPosts) {
      const posts = JSON.parse(rawPosts);
      if (Array.isArray(posts)) {
        posts
          .filter((p) => p && p.published === true && p.inBar === true && p.title)
          .sort((a, b) =>
            (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
            String(b.date || "").localeCompare(String(a.date || ""))
          )
          .forEach((p) => {
            items.push({
              id: "post:" + p.id,
              text: String(p.title).slice(0, 300),
              textEn: String(p.titleEn || "").slice(0, 300),
              link: "/announcements",
              kind: "post",
            });
          });
      }
    }
  } catch (e) {}

  return Response.json(
    { ok: true, items, ...legacy },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
