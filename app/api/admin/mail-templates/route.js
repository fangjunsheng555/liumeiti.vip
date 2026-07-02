// 客服发信快捷模板 — 可发信的员工共用。Redis lm:mail-templates JSON 数组。
import {
  adminSessionFromRequest, adminPermissionProfile, adminActorFromSession,
  pushAdminActionLog, redisCmd, clean, makeId, formatBeijingTime,
} from "../../_utils.js";

export const runtime = "nodejs";
const KEY = "lm:mail-templates";
const MAX_TEMPLATES = 30;

function gate(request) {
  const s = adminSessionFromRequest(request);
  if (!s) return null;
  return adminPermissionProfile(s).canSendMail ? s : null;
}

async function loadTemplates() {
  try {
    const raw = await redisCmd(["GET", KEY]);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}
async function saveTemplates(list) {
  return (await redisCmd(["SET", KEY, JSON.stringify(list.slice(0, MAX_TEMPLATES))])) === "OK";
}

export async function GET(request) {
  if (!gate(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return Response.json({ ok: true, templates: await loadTemplates() });
}

// POST {name, subject, content} 保存;DELETE {id} 删除
export async function POST(request) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const name = clean(body.name, 40);
  const subject = clean(body.subject, 160);
  const content = String(body.content || "").slice(0, 5000);
  if (!name || !content) return Response.json({ ok: false, error: "name_and_content_required" }, { status: 400 });
  const list = await loadTemplates();
  if (list.length >= MAX_TEMPLATES) return Response.json({ ok: false, error: "too_many_templates" }, { status: 400 });
  const now = new Date();
  const tpl = {
    id: makeId("TPL"), name, subject, content,
    createdBy: session.staffUsername || "admin",
    createdAtBeijing: formatBeijingTime(now),
  };
  list.unshift(tpl);
  if (!(await saveTemplates(list))) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  await pushAdminActionLog({ action: "mail_template_save", actor: adminActorFromSession(session), target: "tpl:" + tpl.id, detail: { name } });
  return Response.json({ ok: true, templates: list });
}

export async function DELETE(request) {
  const session = gate(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const id = clean(body.id, 40);
  const list = await loadTemplates();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  if (!(await saveTemplates(next))) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  await pushAdminActionLog({ action: "mail_template_delete", actor: adminActorFromSession(session), target: "tpl:" + id, detail: {} });
  return Response.json({ ok: true, templates: next });
}
