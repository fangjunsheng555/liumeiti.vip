import test from "node:test";
import assert from "node:assert/strict";
import { buildReferenceNotificationEmail } from "../app/api/admin/after-sales/reference-notification-email.js";

const order = {
  orderId: "LMMTEST123",
  serviceLabel: "Netflix",
  status: "completed",
  finalAmount: 168,
  remark: "下单时填写的备注",
  staffNotes: "当前订单备注",
  internalNotes: "不得发送的内部备注",
  items: [{
    service: "netflix",
    label: "Netflix · 单独车位",
    cycle: "1年",
    account: "old@example.com",
    password: "old-password",
    staffAccount: "current@example.com",
    staffPassword: "current-password",
  }],
};

test("reference notice contains current credentials and customer-facing notes without a timeline", () => {
  const result = buildReferenceNotificationEmail({
    orders: [order],
    subject: "账号资料通知",
    message: "请使用下方最新资料登录。",
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    locale: "zh",
  });

  assert.match(result.html, /current@example\.com/);
  assert.match(result.html, /current-password/);
  assert.match(result.html, /下单时填写的备注/);
  assert.match(result.html, /当前订单备注/);
  assert.match(result.html, /请使用下方最新资料登录/);
  assert.doesNotMatch(result.html, /old@example\.com|old-password/);
  assert.doesNotMatch(result.html, /不得发送的内部备注/);
  assert.doesNotMatch(result.html, /订单进度|Order timeline/);
  assert.match(result.html, /name="color-scheme" content="light"/);
  assert.match(result.html, /bgcolor="#ffffff"/);
});
