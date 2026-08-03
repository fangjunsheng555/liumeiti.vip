import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installMarketingRedisMock } from "./helpers/marketing-redis-mock.mjs";

process.env.AUTH_SECRET = "mail-preferences-route-secret-32-characters";
process.env.MAIL_PREFERENCES_SECRET = process.env.AUTH_SECRET;
process.env.KV_REST_API_URL = "http://mail-preferences.redis.test";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.SITE_URL = "https://www.liumeiti.vip";

const redis = installMarketingRedisMock("http://mail-preferences.redis.test");
const preferences = await import("../app/api/_mail-preferences.js");
const delivery = await import("../app/api/_mail-delivery.js");
const preferenceRoute = await import("../app/api/email/preferences/route.js");
const unsubscribeRoute = await import("../app/api/email/unsubscribe/route.js");
const clickRoute = await import("../app/api/marketing/click/route.js");
const smtp2goWebhookRoute = await import("../app/api/webhooks/smtp2go/route.js");
const brevoWebhookRoute = await import("../app/api/webhooks/brevo/route.js");
const resendWebhookRoute = await import("../app/api/webhooks/resend/route.js");
const utils = await import("../app/api/_utils.js");
const { sendSimpleEmail } = utils;
const authSession = await import("../app/api/_auth-session.js");
const accountPreferenceRoute = await import("../app/api/account/email-preferences/route.js");
const marketingTemplateV7 = await import("../app/api/admin/mail/marketing-template-v7.js");
const suppressionRoute = await import("../app/api/admin/mail/suppressions/route.js");
const mailDeliveryAdminRoute = await import("../app/api/admin/mail-delivery/route.js");
const adminToken = utils.signSession({ role: "admin", staffId: 1, staffUsername: "admin", exp: Date.now() + 60_000 });

test("preference and RFC 8058 routes separate marketing opt-out from order mail", async () => {
  const token = await preferences.createMailPreferenceToken("reader@example.com", { campaignId: "CMP-PREF" });
  assert.ok(token);
  const read = await preferenceRoute.GET(new Request(`https://www.liumeiti.vip/api/email/preferences?token=${encodeURIComponent(token)}`));
  const before = await read.json();
  assert.equal(read.status, 200);
  assert.equal(before.preferences.marketing, "unknown");

  const safeGet = await unsubscribeRoute.GET(new Request(`https://www.liumeiti.vip/api/email/unsubscribe?token=${encodeURIComponent(token)}`));
  assert.equal(safeGet.status, 303);
  assert.equal(safeGet.headers.get("location"), `https://www.liumeiti.vip/email/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.equal((await preferences.getMailSendDecision({ email: "reader@example.com", purpose: "marketing" })).allowed, true);

  const wrongType = await unsubscribeRoute.POST(new Request(`https://www.liumeiti.vip/api/email/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ "List-Unsubscribe": "One-Click" }),
  }));
  assert.equal(wrongType.status, 415);
  const wrongField = await unsubscribeRoute.POST(new Request(`https://www.liumeiti.vip/api/email/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "List-Unsubscribe=No",
  }));
  assert.equal(wrongField.status, 400);
  assert.equal((await preferences.getMailSendDecision({ email: "reader@example.com", purpose: "marketing" })).allowed, true);

  const unsubscribe = await unsubscribeRoute.POST(new Request(`https://www.liumeiti.vip/api/email/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  }));
  assert.equal(unsubscribe.status, 200);
  assert.equal((await preferences.getMailSendDecision({ email: "reader@example.com", purpose: "marketing" })).allowed, false);
  assert.equal((await preferences.getMailSendDecision({ email: "reader@example.com", purpose: "transactional", category: "order" })).allowed, true);

  const repeated = await unsubscribeRoute.POST(new Request(`https://www.liumeiti.vip/api/email/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  }));
  assert.equal(repeated.status, 200);

  const update = await preferenceRoute.PATCH(new Request("https://www.liumeiti.vip/api/email/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, preferences: { marketing: "granted", renewal: false } }),
  }));
  const updated = await update.json();
  assert.equal(update.status, 200);
  assert.equal(updated.preferences.marketing, "granted");
  assert.equal(updated.preferences.renewal, false);
});

test("human unsubscribe landing page is read-only until its single confirmation action", async () => {
  const pageSource = await readFile(new URL("../app/email/unsubscribe/page.jsx", import.meta.url), "utf8");
  const confirmationSource = await readFile(new URL("../app/email/unsubscribe/UnsubscribeConfirmation.jsx", import.meta.url), "utf8");
  assert.match(pageSource, /getMailPreferencesByToken/);
  assert.doesNotMatch(pageSource, /unsubscribeMailToken|updateMailPreferences/);
  assert.match(pageSource, /确认退订营销邮件/);
  assert.match(confirmationSource, /确认退订营销邮件/);
  assert.equal((confirmationSource.match(/<button\b/g) || []).length, 1);
  assert.doesNotMatch(confirmationSource, /<select\b/);
  assert.match(confirmationSource, /List-Unsubscribe=One-Click/);
  assert.match(confirmationSource, /method:\s*"POST"/);
  assert.match(confirmationSource, /订单进度、验证码和账户安全邮件/);
});

test("provider webhook route converts hard bounces and complaints into suppression", async () => {
  process.env.SMTP2GO_WEBHOOK_TOKEN = "smtp2go-webhook-test";

  async function webhookFor({ email, messageId, event, reason, eventId }) {
    await delivery.registerEmailDelivery({
      args: { to: email, subject: "campaign", category: "marketing", marketing: true, relatedType: "scheduled_campaign", relatedId: "CMP-WEBHOOK" },
      result: { ok: true, provider: "resend", messageId },
    });
    const payload = JSON.stringify({ id: eventId, event, time: new Date().toISOString(), sendtime: new Date().toISOString(), "message-id": messageId, email_id: `provider-${messageId}`, rcpt: email, subject: "campaign", message: reason });
    return smtp2goWebhookRoute.POST(new Request("https://www.liumeiti.vip/api/webhooks/smtp2go", {
      method: "POST",
      headers: { authorization: "Bearer smtp2go-webhook-test", "content-type": "application/json" },
      body: payload,
    }));
  }

  const bounce = await webhookFor({ email: "hard-bounce@example.com", messageId: "resend-hard-1", event: "bounce", reason: "550 5.1.1 user unknown", eventId: "evt-hard-1" });
  assert.equal(bounce.status, 200);
  assert.equal((await preferences.getMailSendDecision({ email: "hard-bounce@example.com", purpose: "transactional" })).allowed, false);

  const complaint = await webhookFor({ email: "complaint@example.com", messageId: "resend-spam-1", event: "spam", reason: "recipient marked spam", eventId: "evt-spam-1" });
  assert.equal(complaint.status, 200);
  assert.equal((await preferences.getMailSendDecision({ email: "complaint@example.com", purpose: "marketing" })).allowed, false);
  assert.equal((await preferences.getMailSendDecision({ email: "complaint@example.com", purpose: "transactional", category: "order" })).allowed, false);
  assert.equal((await preferences.getMailSendDecision({ email: "complaint@example.com", category: "security" })).allowed, false);
});

test("all provider webhooks return 5xx when event storage is unavailable instead of claiming a duplicate", async () => {
  process.env.SMTP2GO_WEBHOOK_TOKEN = "smtp2go-storage-fault";
  process.env.BREVO_WEBHOOK_TOKEN = "brevo-storage-fault";
  const resendKey = Buffer.alloc(32, 7);
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${resendKey.toString("base64")}`;

  redis.failNextCommand("SET", "lm:mail:delivery:smtp2go-event:");
  const smtp = await smtp2goWebhookRoute.POST(new Request("https://www.liumeiti.vip/api/webhooks/smtp2go", {
    method: "POST",
    headers: { authorization: "Bearer smtp2go-storage-fault", "content-type": "application/json" },
    body: JSON.stringify({ id: "smtp-storage-fault", event: "delivered", time: new Date().toISOString(), email_id: "smtp-provider-storage-fault", rcpt: "smtp-fault@example.com" }),
  }));
  const smtpBody = await smtp.json();
  assert.equal(smtp.status, 500);
  assert.equal(smtpBody.error, "storage_failed");
  assert.notEqual(smtpBody.duplicate, true);

  redis.failNextCommand("SET", "lm:mail:delivery:brevo-event:");
  const brevo = await brevoWebhookRoute.POST(new Request("https://www.liumeiti.vip/api/webhooks/brevo?token=brevo-storage-fault", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "brevo-storage-fault", event: "delivered", ts_event: Math.floor(Date.now() / 1000), email: "brevo-fault@example.com", "message-id": "brevo-provider-storage-fault" }),
  }));
  const brevoBody = await brevo.json();
  assert.equal(brevo.status, 500);
  assert.equal(brevoBody.error, "storage_failed");
  assert.notEqual(brevoBody.duplicate, true);

  const resendId = "resend-storage-fault";
  const resendTimestamp = String(Math.floor(Date.now() / 1000));
  const resendPayload = JSON.stringify({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: "resend-provider-storage-fault", to: ["resend-fault@example.com"] } });
  const resendSignature = createHmac("sha256", resendKey)
    .update(`${resendId}.${resendTimestamp}.${resendPayload}`)
    .digest("base64");
  redis.failNextCommand("SET", "lm:mail:delivery:event:");
  const resend = await resendWebhookRoute.POST(new Request("https://www.liumeiti.vip/api/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": resendId,
      "svix-timestamp": resendTimestamp,
      "svix-signature": `v1,${resendSignature}`,
    },
    body: resendPayload,
  }));
  const resendBody = await resend.json();
  assert.equal(resend.status, 500);
  assert.equal(resendBody.error, "storage_failed");
  assert.notEqual(resendBody.duplicate, true);
});

test("delivery callbacks append a PII-free order trace event", async () => {
  const messageId = "trace-order-message-1";
  const registered = await delivery.registerEmailDelivery({
    args: {
      to: "private-trace-recipient@example.com",
      subject: "private trace subject",
      category: "order",
      relatedType: "order",
      relatedId: "ORDER-TRACE-MAIL-1",
    },
    result: { ok: true, provider: "resend", messageId },
  });
  assert.ok(registered);
  const applied = await delivery.applyResendWebhookEvent({
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: { email_id: messageId, to: ["private-trace-recipient@example.com"], subject: "private trace subject" },
  }, "trace-delivered-event-1");
  assert.equal(applied.ok, true);

  const traceRows = redis.lists.get("lm:trace:order:v1:ORDER-TRACE-MAIL-1") || [];
  assert.equal(traceRows.length, 1);
  const trace = JSON.parse(traceRows[0]);
  assert.equal(trace.stage, "email_delivered");
  assert.equal(trace.component, "mail_delivery");
  assert.equal(trace.operationId, "trace-delivered-event-1");
  const serialized = JSON.stringify(trace);
  assert.doesNotMatch(serialized, /private-trace-recipient|@example\.com|private trace subject/i);
});

test("delivery storage rejects per-row pipeline errors in persistence and message lookup", async () => {
  redis.failNextCommand("SET", "lm:mail:delivery:record:", { error: "record_write_failed" });
  const saved = await delivery.registerEmailDelivery({
    args: { to: "delivery-row-error@example.com", subject: "row error", category: "order", relatedType: "order", relatedId: "ORDER-ROW-ERROR" },
    result: { ok: true, provider: "resend", messageId: "delivery-row-error-message" },
  });
  assert.equal(saved, null);

  redis.failNextCommand("GET", "lm:mail:delivery:message:", { error: "lookup_row_failed" });
  const lookup = await delivery.readEmailDeliveryByMessageId("delivery-row-error-message");
  assert.equal(lookup.ok, false);
  assert.equal(lookup.error, "storage_failed");
  assert.equal(lookup.record, null);
});

test("a webhook completion retry records one stable campaign metric", async () => {
  const campaignId = "CMP-WEBHOOK-METRIC-STABLE";
  const messageId = "metric-stable-message";
  const eventId = "metric-stable-delivered-event";
  const registered = await delivery.registerEmailDelivery({
    args: { to: "metric-stable@example.com", subject: "metric", category: "marketing", marketing: true, relatedType: "scheduled_campaign", relatedId: campaignId },
    result: { ok: true, provider: "resend", messageId },
  });
  assert.ok(registered);
  redis.failNextCommand("EVAL", "lm:mail:delivery:event:", 0, 2);
  const event = {
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: { email_id: messageId, to: ["metric-stable@example.com"] },
  };
  const first = await delivery.applyResendWebhookEvent(event, eventId);
  assert.equal(first.ok, false);
  assert.equal(first.error, "event_completion_failed");
  const retry = await delivery.applyResendWebhookEvent(event, eventId);
  assert.equal(retry.ok, true);
  assert.equal(Number(redis.hashes.get(`lm:mail:marketing:campaign:stats:${campaignId}`)?.get("delivered") || 0), 1);
});

test("marketing provider requests include RFC 8058 headers and explicit opt-outs never reach the provider", async () => {
  process.env.RESEND_API_KEY = "re_mail_preferences_test";
  process.env.RESEND_FROM = "info@liumeiti.vip";
  process.env.EMAIL_PROVIDER = "resend";
  const delegatedFetch = globalThis.fetch;
  const providerPayloads = [];
  globalThis.fetch = async (input, options = {}) => {
    if (new URL(String(input)).origin === "https://api.resend.com") {
      providerPayloads.push(JSON.parse(options.body || "{}"));
      return Response.json({ id: `provider-${providerPayloads.length}` });
    }
    return delegatedFetch(input, options);
  };
  try {
    const sent = await sendSimpleEmail({ to: "headers@example.com", subject: "campaign", text: "open", html: '<a href="https://www.liumeiti.vip/shop">open</a>', category: "marketing", marketing: true, campaignId: "CMP-HEADERS", siteUrl: "https://www.liumeiti.vip", support: {} });
    assert.equal(sent.ok, true);
    assert.equal(providerPayloads.length, 1);
    assert.equal(providerPayloads[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(providerPayloads[0].headers["List-Unsubscribe"], /https:\/\/www\.liumeiti\.vip\/api\/email\/unsubscribe\?token=/);
    assert.match(providerPayloads[0].html, /\/api\/marketing\/click\?token=/);

    await preferences.updateMailPreferences({ email: "headers@example.com", preferences: { marketing: "denied" }, source: "test" });
    const blocked = await sendSimpleEmail({ to: "headers@example.com", subject: "campaign", text: "open", html: "<p>open</p>", category: "marketing", marketing: true, campaignId: "CMP-HEADERS", support: {} });
    assert.equal(blocked.suppressed, true);
    assert.equal(providerPayloads.length, 1);
  } finally {
    globalThis.fetch = delegatedFetch;
  }
});

test("recipient-specific preference links occupy the template footer slot exactly once", async () => {
  const templateHtml = marketingTemplateV7.buildMarketingMailV7Html({
    brandName: "冒央会社",
    siteUrl: "https://www.liumeiti.vip",
    products: [],
    offer: { headline: "邮件页脚检查", ctaPath: "/shop" },
  });
  const prepared = await preferences.prepareMarketingEmail({
    to: "footer-slot@example.com",
    subject: "footer",
    html: templateHtml,
    text: "footer",
    category: "marketing",
    campaignId: "CMP-FOOTER-SLOT",
    siteUrl: "https://www.liumeiti.vip",
  });
  assert.equal((prepared.html.match(/LM_MARKETING_PREFERENCES_V1/g) || []).length, 1);
  assert.doesNotMatch(prepared.html, /LM_MARKETING_PREFERENCES_SLOT_V1/);
  assert.match(prepared.html, /管理邮件偏好/);
  assert.match(prepared.html, /退订营销邮件/);
  assert.match(prepared.html, /\/email\/unsubscribe\?token=/);
  assert.ok(prepared.html.indexOf("Maoyang Taiwan Inc.") < prepared.html.indexOf("LM_MARKETING_PREFERENCES_V1"));
  assert.ok(prepared.html.indexOf("LM_MARKETING_PREFERENCES_V1") < prepared.html.indexOf("优惠、价格与库存以活动页面实时状态为准"));

  const englishPrepared = await preferences.prepareMarketingEmail({
    to: "footer-slot-en@example.com",
    subject: "footer",
    html: templateHtml,
    text: "footer",
    category: "marketing",
    campaignId: "CMP-FOOTER-SLOT-EN",
    siteUrl: "https://www.liumeiti.vip",
    locale: "en",
  });
  assert.match(englishPrepared.html, /Manage email preferences/);
  assert.match(englishPrepared.html, /Unsubscribe from marketing/);
  assert.match(englishPrepared.text, /Manage email preferences:/);
  assert.doesNotMatch(englishPrepared.html, />管理邮件偏好<|>退订营销邮件</);
});

test("first-party click route records a unique click and issues signed order attribution", async () => {
  const contact = await preferences.ensureMailContact("clicker@example.com", { source: "test" });
  const token = preferences.createMarketingClickToken({ campaignId: "CMP-CLICK", contactId: contact.contactId, target: "/shop?utm_source=email" });
  const response = await clickRoute.GET(new Request(`https://www.liumeiti.vip/api/marketing/click?token=${encodeURIComponent(token)}`));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://www.liumeiti.vip/shop?utm_source=email");
  const cookiePair = response.headers.get("set-cookie").split(";", 1)[0];
  const attribution = preferences.marketingAttributionFromRequest(new Request("https://www.liumeiti.vip/api/order", { headers: { cookie: cookiePair } }));
  assert.equal(attribution.campaignId, "CMP-CLICK");
  assert.equal(attribution.model, "last_email_click_30d");
  const [cookieName, cookieToken] = cookiePair.split("=");
  const tampered = `${cookieName}=${cookieToken.slice(0, -1)}${cookieToken.endsWith("a") ? "b" : "a"}`;
  assert.equal(preferences.marketingAttributionFromRequest(new Request("https://www.liumeiti.vip/api/order", { headers: { cookie: tampered } })), null);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 31 * 24 * 60 * 60 * 1000;
    assert.equal(preferences.marketingAttributionFromRequest(new Request("https://www.liumeiti.vip/api/order", { headers: { cookie: cookiePair } })), null);
  } finally {
    Date.now = originalNow;
  }
  const secondToken = preferences.createMarketingClickToken({ campaignId: "CMP-CLICK", contactId: contact.contactId, target: "/services/ai" });
  const second = await clickRoute.GET(new Request(`https://www.liumeiti.vip/api/marketing/click?token=${encodeURIComponent(secondToken)}`));
  assert.equal(second.status, 302);
  assert.equal(Number(redis.hashes.get("lm:mail:marketing:campaign:stats:CMP-CLICK")?.get("uniqueClicks") || 0), 1);
  assert.equal(Number(redis.hashes.get("lm:mail:marketing:campaign:stats:CMP-CLICK")?.get("linkHits") || 0), 2);
});

test("optional lifecycle and order-progress policy fails closed on storage outage while critical mail stays allowed", async () => {
  const delegatedFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    if (new URL(String(input)).origin === "http://mail-preferences.redis.test") return new Response("unavailable", { status: 503 });
    return delegatedFetch(input, options);
  };
  try {
    for (const category of ["renewal", "service_incident", "order", "quote", "after_sales", "order_update"]) {
      const decision = await preferences.getMailSendDecision({ email: `outage-${category}@example.com`, category });
      assert.equal(decision.allowed, false, category);
      assert.equal(decision.policyUnavailable, true, category);
      assert.equal(decision.retryable, true, category);
    }
    const critical = await preferences.getMailSendDecision({ email: "critical-outage@example.com", category: "security" });
    assert.equal(critical.allowed, true);
  } finally {
    globalThis.fetch = delegatedFetch;
  }
});

test("batch marketing and optional-transactional policy rejects per-row Redis errors but accepts a missing contact", async () => {
  const delegatedFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (!injected && url.origin === "http://mail-preferences.redis.test" && url.pathname === "/pipeline") {
      const commands = JSON.parse(options.body || "[]");
      const contactIndex = commands.findIndex((command) => String(command?.[0]).toUpperCase() === "GET" && String(command?.[1]).startsWith("lm:mail:contact:"));
      if (contactIndex >= 0) {
        const response = await delegatedFetch(input, options);
        const rows = await response.json();
        rows[contactIndex] = { error: "upstash_row_failed" };
        injected = true;
        return Response.json(rows);
      }
    }
    return delegatedFetch(input, options);
  };
  let marketing;
  try {
    marketing = await preferences.getMailSendDecisionsBatch({
      emails: ["batch-marketing-row-error@example.com"],
      purpose: "marketing",
      category: "marketing",
      marketing: true,
    });
  } finally {
    globalThis.fetch = delegatedFetch;
  }
  assert.equal(marketing.ok, false);
  assert.equal(marketing.error, "mail_policy_unavailable");
  assert.equal(marketing.decisions.size, 0);

  redis.failNextCommand("GET", "lm:mail:contact:", { error: "nested_row_failed" });
  const optionalOrder = await preferences.getMailSendDecisionsBatch({
    emails: ["batch-order-row-error@example.com"],
    purpose: "transactional",
    category: "order_update",
  });
  assert.equal(optionalOrder.ok, false);
  assert.equal(optionalOrder.decisions.size, 0);

  const missing = await preferences.getMailSendDecisionsBatch({
    emails: ["batch-legitimate-missing@example.com"],
    purpose: "marketing",
    category: "marketing",
    marketing: true,
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.decisions.get("batch-legitimate-missing@example.com")?.allowed, true);
  assert.equal(missing.decisions.get("batch-legitimate-missing@example.com")?.defaultPolicy, true);
});

test("order-progress preferences block real providers and category-only marketing still carries RFC 8058 headers", async () => {
  process.env.RESEND_API_KEY = "re_mail_policy_mapping";
  process.env.RESEND_FROM = "info@liumeiti.vip";
  process.env.EMAIL_PROVIDER = "resend";
  const email = "order-pref@example.com";
  await preferences.ensureMailContact(email, { source: "test" });
  await preferences.updateMailPreferences({ email, preferences: { orderUpdates: false }, source: "test" });
  const delegatedFetch = globalThis.fetch;
  const providerPayloads = [];
  globalThis.fetch = async (input, options = {}) => {
    if (new URL(String(input)).origin === "https://api.resend.com") {
      providerPayloads.push(JSON.parse(options.body || "{}"));
      return Response.json({ id: `provider-policy-${providerPayloads.length}` });
    }
    return delegatedFetch(input, options);
  };
  try {
    for (const category of ["order", "order_update", "quote", "after_sales"]) {
      const result = await sendSimpleEmail({ to: email, subject: category, text: category, category, support: {} });
      assert.equal(result.suppressed, true, category);
    }
    assert.equal(providerPayloads.length, 0, "disabled order progress must never call a provider");
    const critical = await sendSimpleEmail({ to: email, subject: "security", text: "security", category: "security", support: {} });
    assert.equal(critical.ok, true);
    const passwordCorrection = await sendSimpleEmail({ to: email, subject: "password", text: "password", category: "password_update", support: {} });
    assert.equal(passwordCorrection.ok, true, "password-correction links remain an essential security mail");
    const categoryOnlyMarketing = await sendSimpleEmail({
      to: "category-only-marketing@example.com",
      subject: "marketing",
      text: "marketing",
      html: '<a href="https://www.liumeiti.vip/shop">shop</a>',
      category: "marketing",
      campaignId: "CMP-CATEGORY-ONLY",
      siteUrl: "https://www.liumeiti.vip",
      support: {},
    });
    assert.equal(categoryOnlyMarketing.ok, true);
    assert.equal(providerPayloads.length, 3);
    assert.equal(providerPayloads[2].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(providerPayloads[2].headers["List-Unsubscribe"], /\/api\/email\/unsubscribe\?token=/);
  } finally {
    globalThis.fetch = delegatedFetch;
  }
});

test("every admin order-mail callsite is mapped to the user preference it must honor", async () => {
  const orderRouteSource = await readFile(new URL("../app/api/admin/orders/[orderId]/route.js", import.meta.url), "utf8");
  const batchRouteSource = await readFile(new URL("../app/api/admin/orders/batch/route.js", import.meta.url), "utf8");
  const referenceRouteSource = await readFile(new URL("../app/api/admin/after-sales/notify-by-reference/route.js", import.meta.url), "utf8");

  assert.equal((orderRouteSource.match(/category:\s*"order_update"/g) || []).length, 4, "completion and invalid mail must cover proxy and regular orders");
  assert.equal((orderRouteSource.match(/category:\s*"quote"/g) || []).length, 1, "proxy quotes must honor the quote preference");
  assert.equal((orderRouteSource.match(/category:\s*"password_update"/g) || []).length, 2, "new and replayed Spotify correction links must remain critical");
  assert.equal((batchRouteSource.match(/category:\s*"order_update"/g) || []).length, 1, "batch invalidation must honor order preferences");
  assert.equal((referenceRouteSource.match(/category:\s*"order_update"/g) || []).length, 1, "reference notices must honor order preferences");
  assert.doesNotMatch(referenceRouteSource, /category:\s*"transactional"/);
});

test("preference tokens preserve contact language and both preference UIs explain deliverability suppression", async () => {
  const email = "english-preferences@example.com";
  await preferences.ensureMailContact(email, { source: "test", locale: "en" });
  const token = await preferences.createMailPreferenceToken(email, { campaignId: "CMP-EN-PREF" });
  const response = await preferenceRoute.GET(new Request(`https://www.liumeiti.vip/api/email/preferences?token=${encodeURIComponent(token)}`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).locale, "en");

  const pageSource = await readFile(new URL("../app/email/preferences/page.jsx", import.meta.url), "utf8");
  const formSource = await readFile(new URL("../app/email/preferences/PreferenceForm.jsx", import.meta.url), "utf8");
  const accountSource = await readFile(new URL("../app/components/EmailPreferenceSettings.jsx", import.meta.url), "utf8");
  assert.match(pageSource, /result\.locale\s*===\s*"en"/);
  assert.match(pageSource, /Manage email preferences/);
  assert.match(formSource, /initialSuppression/);
  assert.match(formSource, /All delivery is blocked after a hard bounce, complaint/);
  assert.match(accountSource, /setSuppression\(data\.suppression/);
  assert.match(accountSource, /All delivery is blocked after a hard bounce, complaint/);
});

test("both order creation routes persist signed marketing attribution separately from first-touch lm_attr", async () => {
  for (const path of ["app/api/order/route.js", "app/api/quote-orders/route.js"]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /marketingAttribution\s*=\s*marketingAttributionFromRequest\(request\)/, path);
    assert.match(source, /attribution[,\s\S]{0,180}marketingAttribution/, path);
    assert.match(source, /marketingAttribution[,\s\S]{0,220}(?:createdAt|status)/, path);
  }
});

test("preference page prevents long-lived query tokens from leaking through referrers", async () => {
  const source = await readFile(new URL("../app/email/preferences/page.jsx", import.meta.url), "utf8");
  assert.match(source, /referrer:\s*"no-referrer"/);
  assert.match(source, /dynamic\s*=\s*"force-dynamic"/);
  assert.match(source, /revalidate\s*=\s*0/);
  assert.match(source, /referrerPolicy="no-referrer"/);
});

test("CAS updates preserve hard-bounce suppression and three soft bounces add a retryable cooldown", async () => {
  await preferences.ensureMailContact("race@example.com", { source: "test" });
  await Promise.all([
    preferences.suppressMailAddress({ email: "race@example.com", scope: "all", reason: "hard_bounce", source: "webhook" }),
    preferences.updateMailPreferences({ email: "race@example.com", preferences: { marketing: "granted" }, source: "account" }),
  ]);
  const raced = await preferences.getMailContact("race@example.com");
  assert.equal(raced.suppression.scope, "all");
  assert.equal(raced.suppression.reason, "hard_bounce");
  assert.equal(raced.preferences.marketing, "granted");
  assert.equal(raced.consent.marketing.status, "granted");

  for (let index = 0; index < 3; index += 1) {
    const result = await preferences.applyMailFeedback({ email: "soft@example.com", status: "delayed", eventType: "soft_bounce", reason: "mailbox full", provider: "resend", eventId: `soft-${index}` });
    assert.equal(result.ok, true);
  }
  const marketing = await preferences.getMailSendDecision({ email: "soft@example.com", purpose: "marketing" });
  assert.equal(marketing.allowed, false);
  assert.equal(marketing.retryable, true);
  assert.equal(marketing.reason, "soft_bounce_cooldown");
  assert.equal((await preferences.getMailSendDecision({ email: "soft@example.com", purpose: "transactional", category: "order" })).allowed, true);
  await preferences.applyMailFeedback({ email: "soft@example.com", status: "delivered", provider: "resend" });
  assert.equal((await preferences.getMailSendDecision({ email: "soft@example.com", purpose: "marketing" })).allowed, true);
});

test("a contact-index write fault cannot replay a committed soft-bounce mutation", async () => {
  redis.failNextCommand("ZADD", "lm:mail:contacts");
  const result = await preferences.applyMailFeedback({
    email: "soft-index-fault@example.com",
    status: "delayed",
    eventType: "soft_bounce",
    reason: "mailbox full",
    provider: "resend",
    eventId: "soft-index-fault-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.contact.softBounce.count, 1);
  assert.equal(result.cooldown, false);
  const stored = await preferences.getMailContact("soft-index-fault@example.com");
  assert.equal(stored.softBounce.count, 1);
  assert.equal(redis.sortedSets.get("lm:mail:contacts")?.has(stored.contactId), true);
});

test("marketing send fails closed and retryable when the preference secret is unavailable", async () => {
  const previousMailSecret = process.env.MAIL_PREFERENCES_SECRET;
  const previousAuthSecret = process.env.AUTH_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.MAIL_PREFERENCES_SECRET = "";
  process.env.AUTH_SECRET = "auth-secret-must-not-be-used-for-production-mail";
  process.env.NODE_ENV = "production";
  try {
    const result = await sendSimpleEmail({
      to: "no-policy@example.com",
      subject: "campaign",
      text: "campaign",
      html: "<p>campaign</p>",
      category: "marketing",
      marketing: true,
      campaignId: "CMP-NO-POLICY",
      support: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.suppressed, false);
    assert.equal(result.retryable, true);
    assert.equal(result.reason, "policy_unavailable");
  } finally {
    process.env.MAIL_PREFERENCES_SECRET = previousMailSecret;
    process.env.AUTH_SECRET = previousAuthSecret;
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("account preference route records only whitelisted locale values for registered users", async () => {
  const email = "locale-account@example.com";
  const lifecycle = "a".repeat(32);
  redis.execute(["SET", `liumeiti:users:${email}`, JSON.stringify({ email, username: "locale-user", balance: 0 })]);
  redis.execute(["SET", `lm:user:authver:${email}`, "1"]);
  redis.execute(["SET", `lm:user:lifecycle:${email}`, lifecycle]);
  const token = authSession.signUserSessionForVersion(email, 1);

  const getResponse = await accountPreferenceRoute.GET(new Request("https://www.liumeiti.vip/api/account/email-preferences", {
    headers: { cookie: `lm_user=${encodeURIComponent(token)}; locale=en` },
  }));
  assert.equal(getResponse.status, 200);
  assert.equal((await preferences.getMailContact(email)).locale, "en");

  const invalidLocale = await accountPreferenceRoute.PATCH(new Request("https://www.liumeiti.vip/api/account/email-preferences", {
    method: "PATCH",
    headers: { cookie: `lm_user=${encodeURIComponent(token)}`, "content-type": "application/json" },
    body: JSON.stringify({ locale: "fr", preferences: { renewal: false } }),
  }));
  assert.equal(invalidLocale.status, 200);
  assert.equal((await preferences.getMailContact(email)).locale, "en");

  const validLocale = await accountPreferenceRoute.PATCH(new Request("https://www.liumeiti.vip/api/account/email-preferences", {
    method: "PATCH",
    headers: { cookie: `lm_user=${encodeURIComponent(token)}`, "content-type": "application/json" },
    body: JSON.stringify({ locale: "zh", preferences: { renewal: true } }),
  }));
  assert.equal(validLocale.status, 200);
  assert.equal((await preferences.getMailContact(email)).locale, "zh");
});

test("suppression admin route distinguishes an empty store from index and detail outages", async () => {
  redis.sortedSets.delete("lm:mail:contacts");
  redis.sets.delete("lm:mail:suppressed:all");
  redis.sets.delete("lm:mail:suppressed:optional");
  redis.sets.delete("lm:mail:suppressed:marketing");
  const request = () => new Request("https://www.liumeiti.vip/api/admin/mail/suppressions", {
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
  });

  const empty = await suppressionRoute.GET(request());
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).suppressions, []);

  redis.failNextCommand("ZREVRANGE", "lm:mail:contacts");
  const indexOutage = await suppressionRoute.GET(request());
  assert.equal(indexOutage.status, 503);
  assert.equal((await indexOutage.json()).error, "storage_unavailable");

  await preferences.suppressMailAddress({
    email: "suppression-detail-fault@example.com",
    scope: "marketing",
    reason: "test",
    source: "test",
  });
  redis.failNextCommand("GET", "lm:mail:contact:", { error: "detail_read_failed" });
  const detailOutage = await suppressionRoute.GET(request());
  assert.equal(detailOutage.status, 503);
  assert.equal((await detailOutage.json()).error, "storage_unavailable");
});

test("delivery history route distinguishes empty, missing, and per-row storage failures", async () => {
  redis.sortedSets.delete("lm:mail:delivery:index");
  const request = (query = "") => new Request(`https://www.liumeiti.vip/api/admin/mail-delivery${query}`, {
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
  });

  const empty = await mailDeliveryAdminRoute.GET(request());
  const emptyBody = await empty.json();
  assert.equal(empty.status, 200);
  assert.deepEqual(emptyBody.records, []);

  const missing = await mailDeliveryAdminRoute.GET(request("?id=DOES-NOT-EXIST"));
  assert.equal(missing.status, 404);

  redis.failNextCommand("ZREVRANGE", "lm:mail:delivery:index");
  const indexOutage = await mailDeliveryAdminRoute.GET(request());
  assert.equal(indexOutage.status, 503);

  redis.failNextCommand("GET", "lm:mail:delivery:record:", { error: "detail_row_failed" });
  const detailOutage = await mailDeliveryAdminRoute.GET(request("?id=ROW-FAULT"));
  assert.equal(detailOutage.status, 503);

  const record = await delivery.registerEmailDelivery({
    args: { to: "history-row-fault@example.com", subject: "history", category: "order", relatedType: "order", relatedId: "ORDER-HISTORY" },
    result: { ok: true, provider: "resend", messageId: "history-row-fault-message" },
  });
  assert.ok(record);
  redis.failNextCommand("GET", "lm:mail:delivery:record:", { error: "list_row_failed" });
  const listOutage = await mailDeliveryAdminRoute.GET(request());
  assert.equal(listOutage.status, 503);
});
