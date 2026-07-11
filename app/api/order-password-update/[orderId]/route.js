import { createHash, timingSafeEqual } from "node:crypto";
import {
  clean,
  formatBeijingTime,
  getAllOrdersWithIndex,
  setOrderAt,
  validEmail,
} from "../../_utils.js";

function bearerToken(request) {
  const value = request.headers.get("authorization") || "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

function tokenMatches(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const actual = createHash("sha256").update(token).digest();
  let expected;
  try { expected = Buffer.from(expectedHash, "hex"); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function findTarget(orderId, token) {
  const normalizedId = clean(orderId, 80).replace(/\s+/g, "").toUpperCase();
  if (!normalizedId || !token) return { error: "invalid_update_link" };
  const entries = await getAllOrdersWithIndex();
  const entry = entries.find((candidate) => (
    !candidate.order?.deleted
    && String(candidate.order?.orderId || "").toUpperCase() === normalizedId
  ));
  if (!entry) return { error: "order_not_found" };
  if (entry.order.status === "invalid") return { error: "order_invalid" };
  const itemIndex = (entry.order.items || []).findIndex((item) => (
    item?.service === "spotify" && tokenMatches(token, item.passwordCorrectionTokenHash)
  ));
  if (itemIndex < 0) return { error: "invalid_update_link" };
  const item = entry.order.items[itemIndex];
  const expiresAt = new Date(item.passwordCorrectionExpiresAt || 0).getTime();
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return { error: "update_link_expired" };
  return { entry, item, itemIndex };
}

function publicDetails(order, item, itemIndex) {
  return {
    orderId: order.orderId,
    itemIndex,
    label: item.label || "Spotify",
    account: item.account || "",
    email: order.email || "",
    contact: order.contact || "",
    remark: order.remark || "",
    requestedAtBeijing: item.passwordCorrectionRequestedAtBeijing || "",
    updatedAtBeijing: item.customerPasswordUpdatedAtBeijing || "",
  };
}

export async function GET(request, { params }) {
  const { orderId } = await params;
  const target = await findTarget(orderId, bearerToken(request));
  if (target.error) {
    const status = target.error === "order_not_found" ? 404 : target.error === "order_invalid" ? 409 : 401;
    return Response.json({ ok: false, error: target.error }, { status });
  }
  return Response.json({ ok: true, details: publicDetails(target.entry.order, target.item, target.itemIndex) });
}

export async function PATCH(request, { params }) {
  const { orderId } = await params;
  const target = await findTarget(orderId, bearerToken(request));
  if (target.error) {
    const status = target.error === "order_not_found" ? 404 : target.error === "order_invalid" ? 409 : 401;
    return Response.json({ ok: false, error: target.error }, { status });
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const account = clean(body.account, 80);
  const password = clean(body.password, 120);
  const email = clean(body.email, 200).toLowerCase();
  const contact = clean(body.contact, 200);
  const remark = clean(body.remark, 1500);
  if (!account) return Response.json({ ok: false, error: "account_required" }, { status: 400 });
  if (!password) return Response.json({ ok: false, error: "password_required" }, { status: 400 });
  if (!validEmail(email)) return Response.json({ ok: false, error: "invalid_email" }, { status: 400 });
  if (!contact) return Response.json({ ok: false, error: "contact_required" }, { status: 400 });

  const { entry, item, itemIndex } = target;
  const now = new Date();
  item.account = account;
  item.password = password;
  item.customerPasswordUpdatedAt = now.toISOString();
  item.customerPasswordUpdatedAtBeijing = formatBeijingTime(now);
  item.customerPasswordUpdateCount = Number(item.customerPasswordUpdateCount || 0) + 1;
  item.passwordCorrectionResolvedAt = now.toISOString();
  item.passwordCorrectionResolvedAtBeijing = formatBeijingTime(now);
  entry.order.email = email;
  entry.order.contact = contact;
  entry.order.remark = remark;
  entry.order.customerDetailsUpdatedAt = now.toISOString();
  entry.order.customerDetailsUpdatedAtBeijing = formatBeijingTime(now);

  const saved = await setOrderAt(entry.index, entry.order);
  if (!saved) return Response.json({ ok: false, error: "save_failed" }, { status: 500 });
  return Response.json({
    ok: true,
    details: publicDetails(entry.order, item, itemIndex),
    updatedAtBeijing: item.customerPasswordUpdatedAtBeijing,
  });
}
