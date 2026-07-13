// 公告中心 — 后台 CRUD（仅超级管理员）。
import { adminSessionFromRequest, isRootAdminSession } from "../../_utils.js";
import { getMergedCatalog } from "../../_catalog.js";
import { readAnnouncementPosts, saveAnnouncementPosts } from "./_store.js";

export const runtime = "nodejs";
function gate(request) { const s = adminSessionFromRequest(request); return s && isRootAdminSession(s) ? s : null; }

const CATEGORIES = ["company", "business", "system", "promo"];

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const [posts, catalog] = await Promise.all([readAnnouncementPosts(), getMergedCatalog()]);
  const services = catalog.map((product) => ({ key: product.key, label: product.title, active: product.active !== false }));
  return Response.json({ ok: true, posts, services });
}

export async function POST(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const input = body.post || {};
  const catalog = await getMergedCatalog();
  const serviceKeys = new Set(catalog.map((product) => product.key));
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
    affectedService: serviceKeys.has(String(input.affectedService || "")) ? String(input.affectedService) : "",
  };
  const now = Date.now();
  const posts = await readAnnouncementPosts();
  const idx = posts.findIndex((p) => p && Number(p.id) === Number(input.id));
  let post;
  if (idx >= 0) {
    post = { ...posts[idx], ...clean, id: posts[idx].id, createdAt: posts[idx].createdAt || now, updatedAt: now };
    posts[idx] = post;
  } else {
    post = { ...clean, id: now, createdAt: now, updatedAt: now };
    posts.push(post);
  }
  await saveAnnouncementPosts(posts);
  return Response.json({ ok: true, post });
}

export async function DELETE(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const posts = (await readAnnouncementPosts()).filter((p) => p && Number(p.id) !== Number(body.id));
  await saveAnnouncementPosts(posts);
  return Response.json({ ok: true });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
