import assert from "node:assert/strict";
import test from "node:test";

const { reconcileAdminMailLogStatuses } = await import("../app/api/_utils.js");

test("customer mail failure is shown as recovered after a matching resend succeeds", () => {
  const entries = reconcileAdminMailLogStatuses([
    { id: "success", messageId: "message-success", to: "USER@example.com", subject: "冒央会社 · 客服服务通知", ok: true, createdAt: "2026-07-14T10:01:00.000Z", createdAtBeijing: "2026-07-14 18:01:00 北京时间 (UTC+8)" },
    { id: "failure", to: "user@example.com", subject: "冒央会社 · 客服服务通知", ok: false, reason: "send_failed_after_retry", createdAt: "2026-07-14T10:00:00.000Z" },
  ]);

  assert.equal(entries[1].ok, true);
  assert.equal(entries[1].recovered, true);
  assert.equal(entries[1].reason, "");
  assert.equal(entries[1].recoveredBy, "message-success");
});

test("mail recovery does not cross recipients, subjects, or scheduled sends", () => {
  const baseFailure = { to: "user@example.com", subject: "通知 A", ok: false, reason: "failed", createdAt: "2026-07-14T10:00:00.000Z" };
  const entries = reconcileAdminMailLogStatuses([
    { to: "other@example.com", subject: "通知 A", ok: true, createdAt: "2026-07-14T10:03:00.000Z" },
    { to: "user@example.com", subject: "通知 B", ok: true, createdAt: "2026-07-14T10:02:00.000Z" },
    { to: "user@example.com", subject: "通知 A", ok: true, scheduledAt: "2026-07-15T10:00:00.000Z", createdAt: "2026-07-14T10:01:00.000Z" },
    baseFailure,
  ]);

  assert.equal(entries[3].ok, false);
  assert.equal(entries[3].recovered, undefined);
});

test("mail recovery ignores a matching success outside the seven-day window", () => {
  const entries = reconcileAdminMailLogStatuses([
    { to: "user@example.com", subject: "通知", ok: true, createdAt: "2026-07-10T10:00:01.000Z" },
    { to: "user@example.com", subject: "通知", ok: false, createdAt: "2026-07-01T10:00:00.000Z" },
  ]);
  assert.equal(entries[1].ok, false);
});
