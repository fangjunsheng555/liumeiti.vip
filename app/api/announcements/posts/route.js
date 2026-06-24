// 公告中心 — 公开读取已发布公告。置顶优先，再按日期倒序。
import { redisCmd } from "../../_utils.js";

export const runtime = "nodejs";

const POSTS_KEY = "lm:announce:posts";

function loadPosts(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

export async function GET() {
  let posts = [];
  try { posts = loadPosts(await redisCmd(["GET", POSTS_KEY])); } catch (e) {}
  const published = posts
    .filter((p) => p && p.published === true)
    .sort((a, b) =>
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
      String(b.date || "").localeCompare(String(a.date || ""))
    )
    .map((p) => ({
      id: p.id,
      title: p.title || "",
      titleEn: p.titleEn || "",
      body: p.body || "",
      bodyEn: p.bodyEn || "",
      date: p.date || "",
      category: p.category || "",
      pinned: Boolean(p.pinned),
    }));
  return Response.json({ ok: true, posts: published });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
