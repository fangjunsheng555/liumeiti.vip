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

test("single delivery lookups surface corrupt mappings and bodies to webhook recovery", async () => {
  const messageId = "delivery-corrupt-single-lookup";
  const registered = await delivery.registerEmailDelivery({
    args: { to: "delivery-corrupt@example.com", subject: "corrupt", category: "order", relatedType: "order", relatedId: "ORDER-CORRUPT" },
    result: { ok: true, provider: "resend", messageId },
  });
  assert.ok(registered);
  const mappingKey = `lm:mail:delivery:message:${messageId}`;
  const recordKey = `lm:mail:delivery:record:${registered.id}`;
  const originalRecord = redis.values.get(recordKey);
  const deliveryCount = redis.sortedSets.get("lm:mail:delivery:index")?.size || 0;

  redis.values.set(recordKey, "{not-json");
  const corruptBody = await delivery.readEmailDeliveryByMessageId(messageId);
  assert.deepEqual(corruptBody, { ok: false, error: "storage_corrupt", record: null });
  const direct = await delivery.getEmailDelivery(registered.id);
  assert.deepEqual(direct, { ok: false, error: "storage_corrupt", record: null });

  const webhook = await delivery.applyResendWebhookEvent({
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: { email_id: messageId, to: ["delivery-corrupt@example.com"] },
  }, "delivery-corrupt-webhook-event");
  assert.equal(webhook.ok, false);
  assert.equal(webhook.retryable, true);
  assert.equal(webhook.error, "delivery_lookup_failed");
  assert.equal(redis.sortedSets.get("lm:mail:delivery:index")?.size || 0, deliveryCount, "a corrupt mapped record must not be replaced by a detached webhook record");

  redis.values.set(recordKey, originalRecord);
  redis.values.set(mappingKey, `${registered.id} `);
  const corruptMapping = await delivery.readEmailDeliveryByMessageId(messageId);
  assert.deepEqual(corruptMapping, { ok: false, error: "storage_corrupt", record: null });

  redis.values.delete(mappingKey);
  const absent = await delivery.readEmailDeliveryByMessageId(messageId);
  assert.deepEqual(absent, { ok: true, record: null });
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

test("a soft-bounce webhook retry after lease completion failure increments the contact only once", async () => {
  const email = "soft-webhook-replay@example.com";
  const messageId = "soft-webhook-replay-message";
  const eventId = "soft-webhook-replay-event";
  assert.ok(await delivery.registerEmailDelivery({
    args: { to: email, subject: "soft", category: "transactional" },
    result: { ok: true, provider: "resend", messageId },
  }));
  redis.failNextCommand("EVAL", "lm:mail:delivery:event:", 0, 2);
  const event = {
    type: "email.delivery_delayed",
    created_at: new Date().toISOString(),
    data: { email_id: messageId, to: [email], reason: "mailbox full" },
  };
  assert.equal((await delivery.applyResendWebhookEvent(event, eventId)).error, "event_completion_failed");
  assert.equal((await preferences.getMailContact(email)).softBounce.count, 1);
  assert.equal((await delivery.applyResendWebhookEvent(event, eventId)).ok, true);
  const replayed = await preferences.getMailContact(email);
  assert.equal(replayed.softBounce.count, 1);
  assert.deepEqual(replayed.softBounce.eventIds, [eventId]);
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
    products: [{
      key: "spotify",
      name: "Spotify",
      subtitle: "个人、双人及家庭套餐",
      price: "¥128/年起",
      icon: "/products/spotify.jpg",
      href: "https://www.liumeiti.vip/services/spotify",
    }],
    benefits: { bundleTier2Label: "95 折", bundleTier3Label: "9 折", usdtDiscountLabel: "9 折" },
    offer: { headline: "邮件页脚检查", featuredServiceKeys: ["spotify"], ctaPath: "/shop" },
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
  assert.ok((prepared.html.match(/\/api\/marketing\/click\?token=/g) || []).length >= 3, "logo, CTA and product links must all retain campaign attribution");
  assert.ok(prepared.html.indexOf("Maoyang Taiwan Inc.") < prepared.html.indexOf("LM_MARKETING_PREFERENCES_V1"));
  assert.ok(prepared.html.indexOf("LM_MARKETING_PREFERENCES_V1") < prepared.html.indexOf("服务内容、价格与库存以商品详情页及提交订单时显示为准"));
  assert.doesNotMatch(prepared.html, /优惠码|活动页面|DIGITAL MEMBERSHIP DESK|WHY IT MATTERS|RECOMMENDED FOR YOU/i);

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
  await preferences.ensureMailContact("batch-marketing-row-error@example.com", { source: "batch_fault_probe" });
  await preferences.ensureMailContact("batch-order-row-error@example.com", { source: "batch_fault_probe" });
  const delegatedFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (!injected && url.origin === "http://mail-preferences.redis.test" && url.pathname === "/pipeline") {
      const commands = JSON.parse(options.body || "[]");
      const contactIndex = commands.findIndex((command) => String(command?.[0]).toUpperCase() === "TYPE" && String(command?.[1]).startsWith("lm:mail:contact:"));
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

  redis.failNextCommand("TYPE", "lm:mail:contact:", { error: "nested_row_failed" });
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
    const arbitraryId = "a".repeat(40);
    const mismatchedWrite = await preferences.updateMailPreferences({
      email: "secret-missing@example.com", contactId: arbitraryId,
      preferences: { marketing: "denied" }, source: "missing_secret_probe",
    });
    assert.equal(mismatchedWrite.ok, false);
    assert.equal(redis.values.has(preferences.mailPreferenceInternals.contactKey(arbitraryId)), false);
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

test("account preferences atomically repair malformed historical contacts with restrictive defaults", async () => {
  const email = "corrupt-account-preferences@example.com";
  const lifecycle = "b".repeat(32);
  const contactId = preferences.mailContactId(email);
  const key = preferences.mailPreferenceInternals.contactKey(contactId);
  redis.execute(["SET", key, "{not-json"]);
  redis.execute(["SET", `liumeiti:users:${email}`, JSON.stringify({ email, username: "legacy-mail-user", balance: 0 })]);
  redis.execute(["SET", `lm:user:authver:${email}`, "1"]);
  redis.execute(["SET", `lm:user:lifecycle:${email}`, lifecycle]);
  const token = authSession.signUserSessionForVersion(email, 1);

  const request = () => new Request("https://www.liumeiti.vip/api/account/email-preferences", {
    headers: { cookie: `lm_user=${encodeURIComponent(token)}` },
  });
  const [repairedResponse, concurrentResponse] = await Promise.all([
    accountPreferenceRoute.GET(request()),
    accountPreferenceRoute.GET(request()),
  ]);
  assert.equal(repairedResponse.status, 200, await repairedResponse.clone().text());
  assert.equal(concurrentResponse.status, 200, await concurrentResponse.clone().text());
  const repaired = await repairedResponse.json();
  assert.deepEqual(repaired.preferences, {
    marketing: "unknown",
    orderUpdates: true,
    renewal: true,
    serviceNotices: true,
  });
  assert.equal(repaired.suppression.scope, "marketing");
  assert.equal(redis.sets.get("lm:mail:suppressed:all")?.has(contactId) || false, false);
  assert.equal(redis.sets.get("lm:mail:suppressed:marketing")?.has(contactId), true);
  assert.equal(redis.sets.get("lm:mail:suppressed:optional")?.has(contactId) || false, false);
  assert.equal(JSON.parse(redis.values.get(key)).revision >= 1, true);

  const updatedResponse = await accountPreferenceRoute.PATCH(new Request("https://www.liumeiti.vip/api/account/email-preferences", {
    method: "PATCH",
    headers: { cookie: `lm_user=${encodeURIComponent(token)}`, "content-type": "application/json" },
    body: JSON.stringify({ preferences: { marketing: "granted", orderUpdates: true, renewal: true, serviceNotices: true } }),
  }));
  assert.equal(updatedResponse.status, 200);
  assert.deepEqual((await updatedResponse.json()).preferences, {
    marketing: "granted",
    orderUpdates: true,
    renewal: true,
    serviceNotices: true,
  });
  assert.equal((await preferences.getMailContact(email)).suppression.scope, "none");
  for (const purpose of ["critical", "transactional", "marketing"]) {
    const decision = await preferences.getMailSendDecision({ email, purpose, category: purpose === "transactional" ? "order" : "security" });
    assert.equal(decision.allowed, true, `${purpose} must recover after the account owner grants marketing consent`);
  }
});

test("signed preference and one-click tokens repair malformed contacts without allowing delivery", async () => {
  const email = "corrupt-token-preferences@example.com";
  const token = await preferences.createMailPreferenceToken(email);
  const contactId = preferences.mailContactId(email);
  const key = preferences.mailPreferenceInternals.contactKey(contactId);
  redis.execute(["SET", key, "null"]);

  const repairedByToken = await preferenceRoute.GET(new Request(`https://www.liumeiti.vip/api/email/preferences?token=${encodeURIComponent(token)}`));
  assert.equal(repairedByToken.status, 200, await repairedByToken.clone().text());
  assert.equal((await repairedByToken.json()).suppression.scope, "marketing");
  const oneClick = await unsubscribeRoute.POST(new Request(`https://www.liumeiti.vip/api/email/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  }));
  assert.equal(oneClick.status, 200);

  const lifecycle = "c".repeat(32);
  redis.execute(["SET", `liumeiti:users:${email}`, JSON.stringify({ email, username: "repair-owner", balance: 0 })]);
  redis.execute(["SET", `lm:user:authver:${email}`, "1"]);
  redis.execute(["SET", `lm:user:lifecycle:${email}`, lifecycle]);
  const session = authSession.signUserSessionForVersion(email, 1);
  const repair = await accountPreferenceRoute.GET(new Request("https://www.liumeiti.vip/api/account/email-preferences", {
    headers: { cookie: `lm_user=${encodeURIComponent(session)}` },
  }));
  assert.equal(repair.status, 200);

  const recovered = await preferenceRoute.GET(new Request(`https://www.liumeiti.vip/api/email/preferences?token=${encodeURIComponent(token)}`));
  assert.equal(recovered.status, 200);
  const recoveredBody = await recovered.json();
  assert.equal(recoveredBody.preferences.marketing, "denied");
  assert.equal(recoveredBody.suppression.scope, "marketing");
});

test("concurrent signed-token repair losers reread the winner instead of returning a false conflict", async () => {
  const email = "concurrent-token-repair@example.com";
  const token = await preferences.createMailPreferenceToken(email);
  const contactId = preferences.mailContactId(email);
  redis.execute(["SET", preferences.mailPreferenceInternals.contactKey(contactId), "{bad"]);

  const reads = await Promise.all(Array.from({ length: 5 }, () => preferences.getMailPreferencesByToken(token)));
  assert.equal(reads.every((result) => result.ok), true);
  assert.equal(reads.every((result) => result.suppression.scope === "marketing"), true);
  assert.equal(reads.every((result) => result.maskedEmail === "***"), true);
});

test("a repaired token tombstone can persist an explicit marketing grant without an email field", async () => {
  const email = "token-tombstone-grant@example.com";
  const token = await preferences.createMailPreferenceToken(email);
  const contactId = preferences.mailContactId(email);
  redis.execute(["SET", preferences.mailPreferenceInternals.contactKey(contactId), "{bad"]);
  assert.equal((await preferences.getMailPreferencesByToken(token)).ok, true);
  const granted = await preferences.updateMailPreferencesByToken(token, { marketing: "granted" }, "test_grant");
  assert.equal(granted.ok, true);
  assert.equal(granted.contact.email, "");
  assert.equal(granted.contact.preferences.marketing, "granted");
  assert.equal(granted.contact.suppression.scope, "none");
});

test("a valid JSON contact with the wrong identity is repaired instead of looping to 503", async () => {
  const email = "wrong-contact-identity@example.com";
  const contactId = preferences.mailContactId(email);
  const key = preferences.mailPreferenceInternals.contactKey(contactId);
  redis.execute(["SET", key, JSON.stringify({
    contactId: "d".repeat(40),
    email,
    preferences: { marketing: "granted" },
    revision: 9,
  })]);
  redis.execute(["SET", `liumeiti:users:${email}`, JSON.stringify({ email, username: "wrong-id-owner", balance: 0 })]);
  redis.execute(["SET", `lm:user:authver:${email}`, "1"]);
  redis.execute(["SET", `lm:user:lifecycle:${email}`, "d".repeat(32)]);
  const session = authSession.signUserSessionForVersion(email, 1);

  const response = await accountPreferenceRoute.GET(new Request("https://www.liumeiti.vip/api/account/email-preferences", {
    headers: { cookie: `lm_user=${encodeURIComponent(session)}` },
  }));
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.suppression.scope, "marketing");
  assert.equal((await preferences.getMailContact(email)).contactId, contactId);
});

test("a contact with the right id but another email cannot leak through single or token reads", async () => {
  const email = "right-id-wrong-email@example.com";
  const contactId = preferences.mailContactId(email);
  const key = preferences.mailPreferenceInternals.contactKey(contactId);
  redis.execute(["SET", key, JSON.stringify({
    contactId, email: "other-person@example.com", preferences: { marketing: "granted" }, revision: 4,
  })]);
  const decision = await preferences.getMailSendDecision({ email, purpose: "critical", category: "security" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.contact.email, email);

  const token = await preferences.createMailPreferenceToken(email);
  redis.execute(["SET", key, JSON.stringify({
    contactId, email: "token-impostor@example.com", preferences: { marketing: "granted" }, revision: 5,
  })]);
  const tokenRead = await preferences.getMailPreferencesByToken(token);
  assert.equal(tokenRead.ok, true);
  assert.equal(tokenRead.maskedEmail, "***");
});

test("batch send policy treats malformed contacts conservatively without failing healthy recipients", async () => {
  const corruptEmail = "corrupt-batch-preferences@example.com";
  const healthyEmail = "healthy-batch-preferences@example.com";
  await preferences.ensureMailContact(corruptEmail, { source: "test" });
  redis.execute(["SET", preferences.mailPreferenceInternals.contactKey(preferences.mailContactId(corruptEmail)), "[]"]);

  for (const [purpose, category] of [["critical", "security"], ["transactional", "order"], ["marketing", "marketing"]]) {
    const result = await preferences.getMailSendDecisionsBatch({
      emails: [corruptEmail, healthyEmail],
      purpose,
      category,
    });
    assert.equal(result.ok, true);
    assert.equal(result.decisions.get(corruptEmail).allowed, purpose !== "marketing");
    assert.equal(result.decisions.get(healthyEmail).allowed, true);
  }

  redis.execute(["SET", preferences.mailPreferenceInternals.contactKey(preferences.mailContactId(corruptEmail)), JSON.stringify({
    contactId: "e".repeat(40),
    email: "somebody-else@example.com",
    preferences: { marketing: "granted" },
  })]);
  const identityMismatch = await preferences.getMailSendDecisionsBatch({ emails: [corruptEmail, healthyEmail], purpose: "critical", category: "security" });
  assert.equal(identityMismatch.ok, true);
  assert.equal(identityMismatch.decisions.get(corruptEmail).allowed, true);
  assert.equal(identityMismatch.decisions.get(healthyEmail).allowed, true);
});

test("single-recipient repair blocks marketing without locking critical or order mail", async () => {
  for (const [email, raw] of [["direct-corrupt-policy@example.com", "{broken"], ["empty-corrupt-policy@example.com", ""]]) {
    const contactId = preferences.mailContactId(email);
    const key = preferences.mailPreferenceInternals.contactKey(contactId);
    redis.execute(["SET", key, raw]);
    for (const [purpose, category] of [["critical", "security"], ["transactional", "order"], ["marketing", "marketing"]]) {
      const decision = await preferences.getMailSendDecision({ email, purpose, category });
      assert.equal(decision.allowed, purpose !== "marketing", `${email} ${purpose} has the least-locking safe policy`);
    }
    const stored = JSON.parse(redis.values.get(key));
    assert.equal(stored.suppression.scope, "marketing");
    assert.equal(redis.sets.get("lm:mail:suppressed:marketing")?.has(contactId), true);
  }
});

test("a wrong-type contact key is repaired without locking critical mail or account access", async () => {
  const email = "wrong-type-contact@example.com";
  const contactId = preferences.mailContactId(email);
  const key = preferences.mailPreferenceInternals.contactKey(contactId);
  redis.execute(["HSET", key, "legacy", "wrong-type"]);

  for (const [purpose, category] of [["critical", "security"], ["transactional", "order"], ["marketing", "marketing"]]) {
    const decision = await preferences.getMailSendDecision({ email, purpose, category });
    assert.equal(decision.allowed, purpose !== "marketing");
  }
  assert.equal(redis.execute(["TYPE", key]), "string");
  assert.equal(JSON.parse(redis.values.get(key)).suppression.scope, "marketing");

  redis.execute(["SET", `liumeiti:users:${email}`, JSON.stringify({ email, username: "wrong-type-owner", balance: 0 })]);
  redis.execute(["SET", `lm:user:authver:${email}`, "1"]);
  redis.execute(["SET", `lm:user:lifecycle:${email}`, "e".repeat(32)]);
  const session = authSession.signUserSessionForVersion(email, 1);
  const response = await accountPreferenceRoute.GET(new Request("https://www.liumeiti.vip/api/account/email-preferences", {
    headers: { cookie: `lm_user=${encodeURIComponent(session)}` },
  }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).suppression.scope, "marketing");
});

test("one wrong-type batch contact is repaired without dropping a healthy recipient", async () => {
  const badEmail = "wrong-type-batch@example.com";
  const goodEmail = "healthy-batch-neighbor@example.com";
  const badId = preferences.mailContactId(badEmail);
  redis.execute(["HSET", preferences.mailPreferenceInternals.contactKey(badId), "legacy", "wrong-type"]);
  const result = await preferences.getMailSendDecisionsBatch({
    emails: [badEmail, goodEmail], purpose: "critical", category: "security",
  });
  assert.equal(result.ok, true);
  assert.equal(result.decisions.size, 2);
  assert.equal(result.decisions.get(badEmail).allowed, true);
  assert.equal(result.decisions.get(goodEmail).allowed, true);
  assert.equal(JSON.parse(redis.values.get(preferences.mailPreferenceInternals.contactKey(badId))).suppression.scope, "marketing");
});

test("corrupt contacts already present in the hard-suppression index remain blocked for critical mail", async () => {
  const email = "hard-suppressed-corrupt@example.com";
  const contactId = preferences.mailContactId(email);
  redis.execute(["SADD", "lm:mail:suppressed:all", contactId]);
  redis.execute(["SET", preferences.mailPreferenceInternals.contactKey(contactId), "{broken"]);
  const decision = await preferences.getMailSendDecision({ email, purpose: "critical", category: "security" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.contact.suppression.scope, "all");
  redis.execute(["SET", preferences.mailPreferenceInternals.contactKey(contactId), "{broken-again"]);
  const batch = await preferences.getMailSendDecisionsBatch({ emails: [email], purpose: "critical", category: "security" });
  assert.equal(batch.decisions.get(email).allowed, false);
  assert.equal(batch.decisions.get(email).contact.suppression.scope, "all");
});

test("orphan suppression indexes remain authoritative for single, ensure, and batch paths", async () => {
  const directEmail = "orphan-all-direct@example.com";
  const directId = preferences.mailContactId(directEmail);
  redis.execute(["SADD", "lm:mail:suppressed:all", directId]);
  const direct = await preferences.getMailSendDecision({ email: directEmail, purpose: "critical", category: "security" });
  assert.equal(direct.allowed, false);
  assert.equal(JSON.parse(redis.values.get(preferences.mailPreferenceInternals.contactKey(directId))).suppression.scope, "all");

  const ensuredEmail = "orphan-all-ensure@example.com";
  const ensuredId = preferences.mailContactId(ensuredEmail);
  redis.execute(["SADD", "lm:mail:suppressed:all", ensuredId]);
  assert.equal((await preferences.ensureMailContact(ensuredEmail, { source: "campaign" })).suppression.scope, "all");
  assert.equal((await preferences.getMailSendDecision({ email: ensuredEmail, purpose: "marketing" })).allowed, false);

  const batchEmail = "orphan-all-batch@example.com";
  const batchId = preferences.mailContactId(batchEmail);
  redis.execute(["SADD", "lm:mail:suppressed:all", batchId]);
  const batch = await preferences.getMailSendDecisionsBatch({ emails: [batchEmail], purpose: "marketing", category: "marketing" });
  assert.equal(batch.decisions.get(batchEmail).allowed, false);
  assert.equal(batch.decisions.get(batchEmail).contact.suppression.scope, "all");

  const cleanEmail = "orphan-no-index@example.com";
  assert.equal((await preferences.getMailSendDecision({ email: cleanEmail, purpose: "critical" })).allowed, true);
  assert.equal(redis.values.has(preferences.mailPreferenceInternals.contactKey(preferences.mailContactId(cleanEmail))), false);
});

test("orphan optional and marketing indexes recover their exact delivery scope", async () => {
  for (const [scope, blockedPurposes] of [
    ["optional", new Set(["lifecycle", "marketing"])],
    ["marketing", new Set(["marketing"])],
  ]) {
    const email = `orphan-${scope}-scope@example.com`;
    const contactId = preferences.mailContactId(email);
    redis.execute(["SADD", `lm:mail:suppressed:${scope}`, contactId]);
    for (const purpose of ["critical", "transactional", "lifecycle", "marketing"]) {
      const decision = await preferences.getMailSendDecision({ email, purpose, category: purpose === "lifecycle" ? "renewal" : purpose });
      assert.equal(decision.allowed, !blockedPurposes.has(purpose), `${scope} ${purpose}`);
    }
    assert.equal((await preferences.getMailContact(email)).suppression.scope, scope);
  }
});

test("conflicting orphan suppression indexes keep only the strongest all scope", async () => {
  const email = "orphan-conflicting-indexes@example.com";
  const contactId = preferences.mailContactId(email);
  for (const scope of ["marketing", "optional", "all"]) redis.execute(["SADD", `lm:mail:suppressed:${scope}`, contactId]);
  const decision = await preferences.getMailSendDecision({ email, purpose: "critical", category: "security" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.contact.suppression.scope, "all");
  assert.equal(redis.sets.get("lm:mail:suppressed:all")?.has(contactId), true);
  assert.equal(redis.sets.get("lm:mail:suppressed:optional")?.has(contactId) || false, false);
  assert.equal(redis.sets.get("lm:mail:suppressed:marketing")?.has(contactId) || false, false);
});

test("valid hard suppression survives unrelated index read failure and concurrent repair losers", async () => {
  const validEmail = "valid-all-index-fault@example.com";
  await preferences.suppressMailAddress({ email: validEmail, scope: "all", reason: "hard_bounce" });
  redis.failNextCommand("SISMEMBER", "lm:mail:suppressed:optional", { error: "WRONGTYPE index" });
  assert.equal((await preferences.getMailSendDecision({ email: validEmail, purpose: "critical" })).allowed, false);

  const raceEmail = "repair-race-all@example.com";
  const raceId = preferences.mailContactId(raceEmail);
  redis.execute(["SADD", "lm:mail:suppressed:all", raceId]);
  redis.execute(["SET", preferences.mailPreferenceInternals.contactKey(raceId), "{broken"]);
  const decisions = await Promise.all(Array.from({ length: 5 }, () => (
    preferences.getMailSendDecision({ email: raceEmail, purpose: "critical", category: "security" })
  )));
  assert.equal(decisions.every((decision) => !decision.allowed && decision.contact?.suppression?.scope === "all"), true);
});

test("legacy contact revision shapes are repaired without 503, fractions, or lost concurrent updates", async () => {
  const shapes = ["bad", -1, 1.5, 9007199254740992, null, {}];
  for (let index = 0; index < shapes.length; index += 1) {
    const email = `legacy-revision-${index}@example.com`;
    const contact = await preferences.ensureMailContact(email, { source: "test" });
    assert.ok(contact, `failed to create contact for revision shape ${JSON.stringify(shapes[index])}`);
    const key = preferences.mailPreferenceInternals.contactKey(contact.contactId);
    const stored = JSON.parse(redis.values.get(key));
    stored.revision = shapes[index];
    redis.execute(["SET", key, JSON.stringify(stored)]);

    const [left, right] = await Promise.all([
      preferences.updateMailPreferences({ email, preferences: { renewal: false }, source: "revision_probe" }),
      preferences.updateMailPreferences({ email, preferences: { serviceNotices: false }, source: "revision_probe" }),
    ]);
    assert.equal(left.ok, true, `left update failed for ${JSON.stringify(shapes[index])}`);
    assert.equal(right.ok, true, `right update failed for ${JSON.stringify(shapes[index])}`);
    const updated = await preferences.getMailContact(email);
    assert.equal(Number.isSafeInteger(updated.revision), true);
    assert.equal(updated.revision >= 2, true);
    assert.equal(updated.preferences.renewal, false);
    assert.equal(updated.preferences.serviceNotices, false);
  }
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

  const healthy = await preferences.suppressMailAddress({
    email: "healthy-suppression-list@example.com", scope: "marketing", reason: "test", source: "test",
  });
  const wrongTypeId = preferences.mailContactId("wrong-type-suppression-list@example.com");
  redis.execute(["SADD", "lm:mail:suppressed:all", wrongTypeId]);
  redis.execute(["HSET", preferences.mailPreferenceInternals.contactKey(wrongTypeId), "legacy", "wrong-type"]);
  const wrongIdentityId = preferences.mailContactId("wrong-identity-suppression-list@example.com");
  const impostorId = "f".repeat(40);
  redis.execute(["SADD", "lm:mail:suppressed:all", wrongIdentityId]);
  redis.execute(["SET", preferences.mailPreferenceInternals.contactKey(wrongIdentityId), JSON.stringify({
    contactId: impostorId, email: "impostor@example.com", suppression: { scope: "none" },
  })]);
  const wrongEmailId = preferences.mailContactId("wrong-email-suppression-list@example.com");
  redis.execute(["SADD", "lm:mail:suppressed:all", wrongEmailId]);
  redis.execute(["SET", preferences.mailPreferenceInternals.contactKey(wrongEmailId), JSON.stringify({
    contactId: wrongEmailId, email: "different-owner@example.com", suppression: { scope: "none" },
  })]);
  redis.execute(["SADD", "lm:mail:suppressed:all", "not-a-contact-id", `x${"a".repeat(40)}`]);
  const wrongType = await suppressionRoute.GET(request());
  assert.equal(wrongType.status, 503);
  assert.equal((await wrongType.json()).error, "storage_unavailable");
  redis.execute(["DEL", preferences.mailPreferenceInternals.contactKey(wrongTypeId)]);
  const degraded = await suppressionRoute.GET(request());
  assert.equal(degraded.status, 200);
  const degradedRows = (await degraded.json()).suppressions;
  assert.equal(degradedRows.some((row) => row.contactId === healthy.contact.contactId), true);
  assert.equal(degradedRows.some((row) => row.contactId === wrongTypeId && row.suppression.scope === "all"), true);
  assert.equal(degradedRows.some((row) => row.contactId === wrongIdentityId && row.suppression.scope === "all"), true);
  assert.equal(degradedRows.some((row) => row.contactId === impostorId), false);
  assert.equal(degradedRows.some((row) => row.contactId === wrongEmailId && !row.email && row.suppression.scope === "all"), true);
  assert.equal(degradedRows.some((row) => !/^[a-f0-9]{40}$/.test(row.contactId)), false);

  const clearOrphan = await suppressionRoute.DELETE(new Request("https://www.liumeiti.vip/api/admin/mail/suppressions", {
    method: "DELETE",
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}`, "content-type": "application/json" },
    body: JSON.stringify({ contactId: wrongTypeId, reason: "orphan_recovery" }),
  }));
  assert.equal(clearOrphan.status, 200);
  assert.equal(redis.sets.get("lm:mail:suppressed:all")?.has(wrongTypeId) || false, false);
});

test("mail preference writes reject a mismatched email and contact id without corrupting the owner", async () => {
  const victimEmail = "identity-owner@example.com";
  const victim = await preferences.ensureMailContact(victimEmail, { source: "identity_probe" });
  const attempted = await preferences.updateMailPreferences({
    email: "identity-attacker@example.com",
    contactId: victim.contactId,
    preferences: { marketing: "denied" },
    source: "identity_probe",
  });
  assert.equal(attempted.ok, false);
  const unchanged = await preferences.getMailContact(victimEmail);
  assert.equal(unchanged.email, victimEmail);
  assert.equal(unchanged.preferences.marketing, "unknown");
  assert.equal(await preferences.getMailContact("identity-attacker@example.com"), null);
});

test("explicit-id suppression changes reject a different valid email", async () => {
  const ownerEmail = "suppression-owner@example.com";
  const otherEmail = "suppression-other@example.com";
  const owner = await preferences.suppressMailAddress({ email: ownerEmail, scope: "all", reason: "hard_bounce" });
  await preferences.ensureMailContact(otherEmail, { source: "identity_probe" });
  assert.equal((await preferences.clearMailSuppression({ email: otherEmail, contactId: owner.contact.contactId })).ok, false);
  assert.equal((await preferences.suppressMailAddress({ email: otherEmail, contactId: owner.contact.contactId, scope: "all" })).ok, false);
  assert.equal((await preferences.getMailContact(ownerEmail)).suppression.scope, "all");
  assert.equal((await preferences.getMailContact(otherEmail)).suppression.scope, "none");
});

test("legacy invalid soft-bounce counters and future timestamps restart at one", async () => {
  for (const [label, count, lastAt] of [
    ["negative", -7, new Date().toISOString()],
    ["fraction", 1.5, new Date().toISOString()],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1, new Date().toISOString()],
    ["future", 2, "2999-01-01T00:00:00.000Z"],
  ]) {
    const email = `soft-legacy-${label}@example.com`;
    const contact = await preferences.ensureMailContact(email, { source: "legacy_probe" });
    const key = preferences.mailPreferenceInternals.contactKey(contact.contactId);
    const raw = JSON.parse(redis.values.get(key));
    raw.softBounce = { count, lastAt, eventIds: [] };
    redis.execute(["SET", key, JSON.stringify(raw)]);
    const result = await preferences.applyMailFeedback({
      email, status: "delayed", eventType: "soft_bounce", reason: "mailbox full", eventId: `legacy-${label}`,
    });
    assert.equal(result.contact.softBounce.count, 1, label);
    assert.equal(result.cooldown, false, label);
  }
});

test("a permanent 550 bounce cannot be softened by digits in a provider trace", async () => {
  const email = "hard-bounce-trace@example.com";
  const result = await preferences.applyMailFeedback({
    email, status: "bounced", eventType: "bounce",
    reason: "550 5.1.1 permanent user unknown; provider trace 412345", eventId: "hard-trace-1",
  });
  assert.equal(result.contact.suppression.scope, "all");
  assert.equal((await preferences.getMailSendDecision({ email, purpose: "critical" })).allowed, false);
});

test("overlong recipient input is rejected without creating a truncated alias", async () => {
  const overlong = `${"a".repeat(242)}@example.comX`;
  const truncated = overlong.slice(0, 254);
  assert.equal(overlong.length, 255);
  assert.equal(preferences.mailContactId(overlong), "");
  assert.equal((await preferences.getMailSendDecision({ email: overlong, purpose: "marketing" })).reason, "invalid_email");
  assert.equal(await preferences.ensureMailContact(overlong, { source: "overlong_probe" }), null);
  assert.equal(await delivery.registerEmailDelivery({ args: { to: overlong, subject: "alias" }, result: { ok: true, messageId: "overlong-alias" } }), null);
  assert.equal(await preferences.getMailContact(truncated), null);
});

test("post-fix convergence round 1: an exact 254-character recipient remains usable without aliasing", async () => {
  const email = `${"a".repeat(242)}@example.com`;
  assert.equal(email.length, 254);
  const contact = await preferences.ensureMailContact(email, { source: "boundary_probe" });
  assert.equal(contact.email, email);
  assert.equal(contact.contactId, preferences.mailContactId(email));
  const record = await delivery.registerEmailDelivery({
    args: { to: email, subject: "boundary" }, result: { ok: true, messageId: "boundary-254" },
  });
  assert.equal(record.to, email);
});

test("post-fix convergence round 1: a 550 mailbox-full response is still a hard bounce", async () => {
  const email = "hard-mailbox-full@example.com";
  const result = await preferences.applyMailFeedback({
    email, status: "bounced", eventType: "bounce",
    reason: "550 5.2.2 mailbox full; permanent failure", eventId: "hard-mailbox-full-1",
  });
  assert.equal(result.contact.suppression.scope, "all");
  assert.equal((await preferences.getMailSendDecision({ email, purpose: "critical" })).allowed, false);
});

test("post-fix convergence round 1: an explicit soft-bounce event outranks contradictory provider text", async () => {
  const email = "explicit-soft-provider@example.com";
  const result = await preferences.applyMailFeedback({
    email, status: "bounced", eventType: "soft_bounce",
    reason: "550 provider mislabeled this temporary deferral", eventId: "explicit-soft-1",
  });
  assert.equal(result.soft, true);
  assert.equal(result.contact.softBounce.count, 1);
  assert.equal(result.contact.suppression.scope, "none");
  assert.equal((await preferences.getMailSendDecision({ email, purpose: "critical" })).allowed, true);
});

test("post-fix convergence round 1: a maximum-safe legacy bounce counter restarts instead of overflowing", async () => {
  const email = "soft-max-safe@example.com";
  const contact = await preferences.ensureMailContact(email, { source: "boundary_probe" });
  const key = preferences.mailPreferenceInternals.contactKey(contact.contactId);
  const raw = JSON.parse(redis.values.get(key));
  raw.softBounce = { count: Number.MAX_SAFE_INTEGER, lastAt: new Date().toISOString(), eventIds: [] };
  redis.execute(["SET", key, JSON.stringify(raw)]);
  const result = await preferences.applyMailFeedback({
    email, status: "delayed", eventType: "soft_bounce", reason: "temporary", eventId: "max-safe-next",
  });
  assert.equal(result.contact.softBounce.count, 1);
  assert.equal(result.cooldown, false);
});

test("post-fix convergence round 1: an orphan optional suppression can be listed and cleared by contact id", async () => {
  const email = "orphan-optional-admin-clear@example.com";
  const contactId = preferences.mailContactId(email);
  redis.execute(["SADD", "lm:mail:suppressed:optional", contactId]);
  const listed = await suppressionRoute.GET(new Request("https://www.liumeiti.vip/api/admin/mail/suppressions", {
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
  }));
  assert.equal((await listed.json()).suppressions.some((row) => row.contactId === contactId && row.suppression.scope === "optional"), true);
  const cleared = await suppressionRoute.DELETE(new Request("https://www.liumeiti.vip/api/admin/mail/suppressions", {
    method: "DELETE",
    headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}`, "content-type": "application/json" },
    body: JSON.stringify({ contactId }),
  }));
  assert.equal(cleared.status, 200);
  assert.equal(redis.sets.get("lm:mail:suppressed:optional")?.has(contactId) || false, false);
  assert.equal((await preferences.getMailSendDecision({ email, purpose: "marketing" })).allowed, true);
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

test("a hanging Resend request is aborted at the caller deadline without starting a retry", async () => {
  const delegatedFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    if (new URL(String(input)).origin !== "https://api.resend.com") return delegatedFetch(input, options);
    providerCalls += 1;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("deadline", "AbortError"));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const startedAt = Date.now();
  try {
    const result = await sendSimpleEmail({
      to: "resend-hanging-deadline@example.com",
      subject: "deadline",
      text: "deadline",
      category: "security",
      forceProvider: "resend",
      deadlineAt: Date.now() + 80,
      skipDeliveryTracking: true,
      support: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.deadlineExceeded, true);
    assert.equal(result.retryDeferred, true);
    assert.equal(result.providerAttempted, true);
    assert.equal(providerCalls, 1);
    assert.ok(Date.now() - startedAt < 750, "a caller deadline must bound a hanging provider");
  } finally {
    globalThis.fetch = delegatedFetch;
  }
});

test("Resend does not start a second request when the remaining retry budget is insufficient", async () => {
  const delegatedFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    if (new URL(String(input)).origin !== "https://api.resend.com") return delegatedFetch(input, options);
    providerCalls += 1;
    return Response.json({ message: "upstream unavailable" }, { status: 503 });
  };
  try {
    const result = await sendSimpleEmail({
      to: "resend-no-retry-budget@example.com",
      subject: "deadline",
      text: "deadline",
      category: "security",
      forceProvider: "resend",
      deadlineAt: Date.now() + 500,
      skipDeliveryTracking: true,
      support: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.deadlineExceeded, true);
    assert.equal(result.retryDeferred, true);
    assert.equal(result.reason, "provider_retry_budget_exhausted");
    assert.equal(providerCalls, 1);
  } finally {
    globalThis.fetch = delegatedFetch;
  }
});

test("a definite Resend 400 keeps its failure semantics when there is no retry budget", async () => {
  const delegatedFetch = globalThis.fetch;
  const previousApiKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.RESEND_FROM;
  const previousProvider = process.env.EMAIL_PROVIDER;
  const previousTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousTelegramChat = process.env.TELEGRAM_CHAT_ID;
  process.env.RESEND_API_KEY = "re_definite_deadline_test";
  process.env.RESEND_FROM = "info@liumeiti.vip";
  process.env.EMAIL_PROVIDER = "resend";
  process.env.TELEGRAM_BOT_TOKEN = "deadline-alert-token";
  process.env.TELEGRAM_CHAT_ID = "deadline-alert-chat";
  let providerCalls = 0;
  let telegramCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.origin === "http://mail-preferences.redis.test"
        && decodeURIComponent(url.pathname).includes("lm:mail-alert:throttle")) return new Promise(() => {});
    if (url.origin === "https://api.telegram.org") {
      telegramCalls += 1;
      return Response.json({ ok: true });
    }
    if (url.origin !== "https://api.resend.com") return delegatedFetch(input, options);
    providerCalls += 1;
    return Response.json({ message: "invalid recipient" }, { status: 400 });
  };
  const startedAt = Date.now();
  try {
    const result = await sendSimpleEmail({
      to: "resend-definite-no-retry@example.com",
      subject: "deadline",
      text: "deadline",
      category: "security",
      forceProvider: "resend",
      deadlineAt: Date.now() + 500,
      skipDeliveryTracking: true,
      support: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 400);
    assert.equal(result.retrySkipped, true);
    assert.notEqual(result.retryable, true);
    assert.notEqual(result.deadlineExceeded, true);
    assert.equal(providerCalls, 1);
    assert.equal(telegramCalls, 0);
    assert.ok(Date.now() - startedAt < 900, "alert throttling must share the caller deadline");
  } finally {
    globalThis.fetch = delegatedFetch;
    if (previousApiKey == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previousApiKey;
    if (previousFrom == null) delete process.env.RESEND_FROM; else process.env.RESEND_FROM = previousFrom;
    if (previousProvider == null) delete process.env.EMAIL_PROVIDER; else process.env.EMAIL_PROVIDER = previousProvider;
    if (previousTelegramToken == null) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = previousTelegramToken;
    if (previousTelegramChat == null) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = previousTelegramChat;
  }
});

test("a hanging marketing policy read reaches its deadline without ever calling a provider", async () => {
  const delegatedFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    const origin = new URL(String(input)).origin;
    if (origin === "http://mail-preferences.redis.test") return new Promise(() => {});
    if (origin === "https://api.resend.com") {
      providerCalls += 1;
      return Response.json({ id: "must-not-send" });
    }
    return delegatedFetch(input, options);
  };
  try {
    const result = await sendSimpleEmail({
      to: "policy-hanging-deadline@example.com",
      subject: "policy deadline",
      text: "policy deadline",
      html: "<p>policy deadline</p>",
      category: "marketing",
      marketing: true,
      campaignId: "CMP-POLICY-DEADLINE",
      forceProvider: "resend",
      deadlineAt: Date.now() + 80,
      skipDeliveryTracking: true,
      support: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.deadlineExceeded, true);
    assert.equal(result.providerAttempted, false);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = delegatedFetch;
  }
});

test("delivery history route keeps healthy string and object rows beside corrupt records", async () => {
  const indexKey = "lm:mail:delivery:index";
  const prefix = "lm:mail:delivery:record:";
  const index = redis.sortedSets.get(indexKey) || new Map();
  redis.sortedSets.set(indexKey, index);
  const score = Date.now() + 10_000;
  index.set("MD-PARTIAL-STRING", score + 3);
  index.set("MD-PARTIAL-OBJECT", score + 2);
  index.set("MD-PARTIAL-BROKEN", score + 1);
  index.set("MD-PARTIAL-MISSING", score);
  index.set("MD-PARTIAL-EMPTY", score - 1);
  index.set("MD-PARTIAL-MISMATCH", score - 2);
  redis.values.set(prefix + "MD-PARTIAL-STRING", JSON.stringify({
    id: "MD-PARTIAL-STRING", status: "delivered", provider: "resend", to: "string@example.com",
  }));
  redis.values.set(prefix + "MD-PARTIAL-OBJECT", {
    id: "MD-PARTIAL-OBJECT", status: "delivered", provider: "resend", to: "object@example.com",
  });
  redis.values.set(prefix + "MD-PARTIAL-BROKEN", "{not-json");
  redis.values.set(prefix + "MD-PARTIAL-EMPTY", {});
  redis.values.set(prefix + "MD-PARTIAL-MISMATCH", {
    id: "MD-ANOTHER-DELIVERY", status: "delivered", provider: "resend", to: "mismatch@example.com",
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let response;
  try {
    response = await mailDeliveryAdminRoute.GET(new Request("https://www.liumeiti.vip/api/admin/mail-delivery?limit=300", {
      headers: { cookie: `lm_admin=${encodeURIComponent(adminToken)}` },
    }));
  } finally {
    console.warn = originalWarn;
  }
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.records.some((record) => record.id === "MD-PARTIAL-STRING"), true);
  assert.equal(body.records.some((record) => record.id === "MD-PARTIAL-OBJECT"), true);
  assert.equal(body.records.some((record) => record.id === "MD-PARTIAL-BROKEN"), false);
  assert.equal(body.records.some((record) => record.id === "MD-PARTIAL-MISSING"), false);
  assert.equal(body.records.some((record) => record.id === "MD-PARTIAL-EMPTY"), false);
  assert.equal(body.records.some((record) => record.id === "MD-ANOTHER-DELIVERY"), false);
  assert.equal(warnings.some((entry) => entry[1]?.skipped === 4), true);
});
