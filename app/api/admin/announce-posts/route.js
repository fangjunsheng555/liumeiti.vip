// 公告中心 — 后台 CRUD（仅超级管理员）。
import { adminSessionFromRequest, isRootAdminSession, redisCmd } from "../../_utils.js";

export const runtime = "nodejs";
function gate(request) { const s = adminSessionFromRequest(request); return s && isRootAdminSession(s) ? s : null; }

const POSTS_KEY = "lm:announce:posts";
const CATEGORIES = ["company", "business", "system", "promo"];

function loadPosts(raw) {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

async function readPosts() {
  try { return loadPosts(await redisCmd(["GET", POSTS_KEY])); } catch (e) { return []; }
}

async function savePosts(posts) {
  await redisCmd(["SET", POSTS_KEY, JSON.stringify(posts)]);
}

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const posts = await readPosts();
  return Response.json({ ok: true, posts });
}

export async function POST(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const input = body.post || {};
  const category = CATEGORIES.includes(input.category) ? input.category : "";
  const clean = {
    title: String(input.title || "").slice(0, 160),
    titleEn: String(input.titleEn || "").slice(0, 160),
    body: String(input.body || "").slice(0, 4000),
    bodyEn: String(input.bodyEn || "").slice(0, 4000),
    date: String(input.date || "").slice(0, 40).trim(),
    category,
    pinned: Boolean(input.pinned),
    published: Boolean(input.published),
    inBar: Boolean(input.inBar),   // 在站内公告顶栏轮播(只轮播标题)
  };
  const now = Date.now();
  const posts = await readPosts();
  const idx = posts.findIndex((p) => p && Number(p.id) === Number(input.id));
  let post;
  if (idx >= 0) {
    post = { ...posts[idx], ...clean, id: posts[idx].id, createdAt: posts[idx].createdAt || now, updatedAt: now };
    posts[idx] = post;
  } else {
    post = { ...clean, id: now, createdAt: now, updatedAt: now };
    posts.push(post);
  }
  await savePosts(posts);
  return Response.json({ ok: true, post });
}

export async function DELETE(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const posts = (await readPosts()).filter((p) => p && Number(p.id) !== Number(body.id));
  await savePosts(posts);
  return Response.json({ ok: true });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
