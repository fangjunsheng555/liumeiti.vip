import {
  checkRateLimit,
  clean,
  formatBeijingTime,
  getCookieFromRequest,
  getOrderById,
  makeId,
  rateLimitResponse,
  validEmail,
  verifySession,
} from "../_utils.js";
import { getMergedCatalog } from "../_catalog.js";
import { createAfterSalesTicket, publicAfterSalesSummary } from "./_store.js";
import { sendAfterSalesEmail } from "./_email.js";

function normalizeOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function normalizeEmail(value) {
  return clean(value, 200).toLowerCase().trim();
}

function submittedItemAt(items, index) {
  return (Array.isArray(items) ? items : []).find((item) => Number(item?.index) === index) || {};
}

function isCredentialService(service) {
  return ["spotify", "ai", "netflix", "disney", "max"].includes(clean(service, 40).toLowerCase());
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch {}

  const orderId = normalizeOrderId(body.orderId);
  const claim = verifySession(clean(body.token, 4000));
  if (!claim || claim.type !== "after-sales-order" || normalizeOrderId(claim.orderId) !== orderId) {
    return Response.json({ ok: false, error: "verification_required" }, { status: 401 });
  }

  const order = await getOrderById(orderId);
  if (!order || normalizeEmail(order.email) !== normalizeEmail(claim.email)) {
    return Response.json({ ok: false, error: "order_not_found" }, { status: 404 });
  }
  if (order.status === "invalid") {
    return Response.json({ ok: false, error: "order_not_eligible" }, { status: 409 });
  }
  if (!validEmail(order.email)) {
    return Response.json({ ok: false, error: "order_email_missing" }, { status: 400 });
  }

  const issue = clean(body.issue, 2000);
  const contact = clean(body.contact, 200);
  const remark = clean(body.remark, 1500);
  if (issue.length < 5) {
    return Response.json({ ok: false, error: "issue_required" }, { status: 400 });
  }

  const guard = await checkRateLimit(request, {
    namespace: "after-sales:create",
    limit: 5,
    windowSec: 30 * 60,
    identity: `${orderId}|${order.email}`,
  });
  if (!guard.ok) return rateLimitResponse(guard, "售后申请提交过于频繁，请稍后再试");

  const catalog = await getMergedCatalog();
  const catalogByKey = Object.fromEntries(catalog.map((product) => [product.key, product]));
  const sourceItems = Array.isArray(order.items) && order.items.length ? order.items : [{
    service: order.service,
    label: order.serviceLabel,
    plan: order.plan || order.rocketPlan || "",
    account: order.account || "",
    password: order.password || "",
    platformUrl: order.platformUrl || "",
    productPrice: order.productPrice || "",
  }];
  let contactRequired = false;
  const items = [];
  for (let index = 0; index < sourceItems.length; index += 1) {
    const source = sourceItems[index] || {};
    const submitted = submittedItemAt(body.items, index);
    const product = catalogByKey[source.service] || {};
    const credentialManaged = isCredentialService(source.service);
    const customerCredentialsRequired = Boolean(product.needsAccountPassword || source.service === "spotify");
    const isProxy = source.service === "proxy-pay";
    contactRequired = contactRequired || Boolean(product.needsContact || isProxy);
    const account = credentialManaged ? clean(submitted.account ?? source.staffAccount ?? source.account, 80) : "";
    const password = credentialManaged ? clean(submitted.password ?? source.staffPassword ?? source.password, 120) : "";
    const platformUrl = isProxy ? clean(submitted.platformUrl ?? source.platformUrl ?? order.platformUrl, 1000) : "";
    const productPrice = isProxy ? clean(submitted.productPrice ?? source.productPrice ?? order.productPrice, 120) : "";
    if (customerCredentialsRequired && (!account || !password)) {
      return Response.json({ ok: false, error: "missing_credentials", itemIndex: index }, { status: 400 });
    }
    if (isProxy && (!/^https?:\/\//i.test(platformUrl) || !productPrice)) {
      return Response.json({ ok: false, error: "missing_proxy_details", itemIndex: index }, { status: 400 });
    }
    items.push({
      index,
      service: clean(source.service, 40),
      label: clean(source.label || order.serviceLabel || source.service, 180),
      plan: clean(source.plan || source.rocketPlan, 40),
      credentialManaged,
      account,
      password,
      platformUrl,
      productPrice,
    });
  }
  if (contactRequired && !contact) {
    return Response.json({ ok: false, error: "contact_required" }, { status: 400 });
  }

  const now = new Date();
  const ticket = {
    ticketId: makeId("AS"),
    orderId,
    status: "pending",
    locale: getCookieFromRequest(request, "locale") === "en" ? "en" : (order.locale === "en" ? "en" : "zh"),
    email: normalizeEmail(order.email),
    contact,
    remark,
    issue,
    items,
    itemCount: items.length,
    serviceLabel: clean(order.serviceLabel || items.map((item) => item.label).join(" + "), 300),
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
    completedAt: "",
    completedAtBeijing: "",
    staffNote: "",
  };
  const created = await createAfterSalesTicket(ticket);
  if (!created.ok) {
    return Response.json({
      ok: false,
      error: created.error,
      ticket: publicAfterSalesSummary(created.ticket),
    }, { status: created.error === "pending_ticket_exists" ? 409 : 500 });
  }

  const mailResult = await sendAfterSalesEmail(created.ticket, "received").catch(() => ({ ok: false }));
  return Response.json({
    ok: true,
    ticket: publicAfterSalesSummary(created.ticket),
    notice: { email: Boolean(mailResult?.ok) },
  });
}

export async function GET() {
  return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
