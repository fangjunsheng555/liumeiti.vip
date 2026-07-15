import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";

import {
  mailDeliveryInternals,
  verifyBrevoWebhookToken,
  verifyResendWebhookSignature,
  verifySmtp2goWebhookAuthorization,
} from "../app/api/_mail-delivery.js";

test("Resend webhook signature accepts a valid current payload", () => {
  const rawKey = randomBytes(32);
  const secret = `whsec_${rawKey.toString("base64")}`;
  const id = "msg_test_01";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({ type: "email.delivered", data: { email_id: "email_01" } });
  const signature = createHmac("sha256", rawKey)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");

  assert.equal(verifyResendWebhookSignature({
    payload,
    id,
    timestamp,
    signature: `v1,${signature}`,
    secret,
  }), true);
});

test("Resend webhook signature rejects tampering and stale timestamps", () => {
  const rawKey = randomBytes(32);
  const secret = `whsec_${rawKey.toString("base64")}`;
  const id = "msg_test_02";
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const payload = "{}";
  const signature = createHmac("sha256", rawKey)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");

  assert.equal(verifyResendWebhookSignature({ payload: "{\"changed\":true}", id, timestamp, signature: `v1,${signature}`, secret, now }), false);
  assert.equal(verifyResendWebhookSignature({ payload, id, timestamp, signature: `v1,${signature}`, secret, now: now + 6 * 60 * 1000 }), false);
});

test("delivery status never regresses from a terminal problem or delivery", () => {
  assert.equal(mailDeliveryInternals.nextStatus("scheduled", "sent"), "sent");
  const { nextStatus } = mailDeliveryInternals;
  assert.equal(nextStatus("sent", "delivered"), "delivered");
  assert.equal(nextStatus("delivered", "sent"), "delivered");
  assert.equal(nextStatus("bounced", "delivered"), "bounced");
  assert.equal(nextStatus("failed", "delayed"), "failed");
});

test("recipient and category metadata is normalized without message content", () => {
  const { normalizeRecipients, normalizedCategory } = mailDeliveryInternals;
  assert.deepEqual(normalizeRecipients([" User@Example.com ", "bad", "user@example.com"]), ["user@example.com"]);
  assert.equal(normalizedCategory("Password Update"), "password_update");
  assert.equal(normalizedCategory("", true), "marketing");
});

test("SMTP2GO webhook authorization requires the configured bearer token", () => {
  assert.equal(verifySmtp2goWebhookAuthorization("Bearer webhook-secret", "webhook-secret"), true);
  assert.equal(verifySmtp2goWebhookAuthorization("Bearer wrong-secret", "webhook-secret"), false);
  assert.equal(verifySmtp2goWebhookAuthorization("", "webhook-secret"), false);
});

test("SMTP2GO identifiers, timestamps and delivery events normalize for shared tracking", () => {
  const { SMTP2GO_EVENT_STATUS, canonicalMessageId, normalizeEventTime, smtp2goEventKey } = mailDeliveryInternals;
  assert.equal(canonicalMessageId(" <lm-test@liumeiti.vip> "), "lm-test@liumeiti.vip");
  assert.equal(normalizeEventTime("2026-07-14 10:30:00"), "2026-07-14T10:30:00.000Z");
  assert.equal(SMTP2GO_EVENT_STATUS.processed, "sent");
  assert.equal(SMTP2GO_EVENT_STATUS.delivered, "delivered");
  assert.equal(SMTP2GO_EVENT_STATUS.bounce, "bounced");
  assert.equal(SMTP2GO_EVENT_STATUS.spam, "complained");
  assert.equal(SMTP2GO_EVENT_STATUS.reject, "suppressed");
  const processed = { id: "same-webhook", event: "processed", time: "2026-07-14 10:30:00", email_id: "email-1", rcpt: "user@example.com" };
  const delivered = { ...processed, event: "delivered", time: "2026-07-14 10:31:00" };
  assert.equal(smtp2goEventKey(processed), smtp2goEventKey({ ...processed }));
  assert.notEqual(smtp2goEventKey(processed), smtp2goEventKey(delivered));
});

test("Brevo webhook token and delivery events normalize for shared tracking", () => {
  const { BREVO_EVENT_STATUS, brevoCustomMessageId, brevoEventKey } = mailDeliveryInternals;
  assert.equal(verifyBrevoWebhookToken("brevo-secret", "brevo-secret"), true);
  assert.equal(verifyBrevoWebhookToken("Bearer brevo-secret", "brevo-secret"), true);
  assert.equal(verifyBrevoWebhookToken("wrong", "brevo-secret"), false);
  assert.equal(BREVO_EVENT_STATUS.request, "sent");
  assert.equal(BREVO_EVENT_STATUS.delivered, "delivered");
  assert.equal(BREVO_EVENT_STATUS.soft_bounce, "delayed");
  assert.equal(BREVO_EVENT_STATUS.hard_bounce, "bounced");
  assert.equal(BREVO_EVENT_STATUS.spam, "complained");
  assert.equal(BREVO_EVENT_STATUS.blocked, "suppressed");
  const delivered = {
    id: 77,
    event: "delivered",
    ts_event: 1784100000,
    email: "user@example.com",
    "message-id": "brevo-message@example",
    "X-Mailin-custom": JSON.stringify({ site_message_id: "lm-site@example" }),
  };
  assert.equal(brevoCustomMessageId(delivered), "lm-site@example");
  assert.equal(brevoEventKey(delivered), brevoEventKey({ ...delivered }));
  assert.notEqual(brevoEventKey(delivered), brevoEventKey({ ...delivered, event: "hard_bounce" }));
});

test("an older failed delivery is recovered only by a matching newer successful resend", () => {
  const { reconcileDeliveryStatuses } = mailDeliveryInternals;
  const base = {
    to: "user@example.com",
    subject: "冒央会社 · 客服服务通知",
    category: "support",
    relatedType: "admin_mail",
    relatedId: "",
  };
  const records = reconcileDeliveryStatuses([
    { ...base, id: "new-success", messageId: "success@example", status: "sent", createdAt: "2026-07-14T10:01:00.000Z", updatedAt: "2026-07-14T10:01:00.000Z", updatedAtBeijing: "2026-07-14 18:01:00 北京时间 (UTC+8)" },
    { ...base, id: "old-failure", status: "failed", reason: "quota", createdAt: "2026-07-14T10:00:00.000Z", updatedAt: "2026-07-14T10:00:00.000Z" },
    { ...base, id: "other-recipient", to: "other@example.com", status: "failed", createdAt: "2026-07-14T10:00:00.000Z", updatedAt: "2026-07-14T10:00:00.000Z" },
    { ...base, id: "other-subject", subject: "另一封通知", status: "failed", createdAt: "2026-07-14T10:00:00.000Z", updatedAt: "2026-07-14T10:00:00.000Z" },
  ]);

  assert.equal(records[1].status, "recovered");
  assert.equal(records[1].reason, "");
  assert.equal(records[1].recoveredBy, "success@example");
  assert.equal(records[2].status, "failed");
  assert.equal(records[3].status, "failed");
});

test("a newer failed retry does not recover an earlier failure", () => {
  const { reconcileDeliveryStatuses } = mailDeliveryInternals;
  const records = reconcileDeliveryStatuses([
    { id: "new-failure", to: "user@example.com", subject: "通知", category: "support", status: "failed", createdAt: "2026-07-14T10:01:00.000Z" },
    { id: "old-failure", to: "user@example.com", subject: "通知", category: "support", status: "failed", createdAt: "2026-07-14T10:00:00.000Z" },
  ]);
  assert.deepEqual(records.map((record) => record.status), ["failed", "failed"]);
});
