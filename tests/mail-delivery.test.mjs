import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";

import {
  mailDeliveryInternals,
  verifyResendWebhookSignature,
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
