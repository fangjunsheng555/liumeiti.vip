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
  assert.doesNotMatch(result.html, /客服通知|本次客服通知/);
  assert.doesNotMatch(result.text, /客服通知|本次客服通知/);
  assert.match(result.html, /name="color-scheme" content="light"/);
  assert.match(result.html, /bgcolor="#ffffff"/);
});

test("reference notice uses a concise customer-facing default subject", () => {
  const result = buildReferenceNotificationEmail({
    orders: [order],
    subject: "",
    message: "请查看最新订单资料。",
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    locale: "zh",
  });

  assert.equal(result.subject, "订单服务更新");
  assert.doesNotMatch(result.html, /客服通知/);
});

test("reference notice never exposes a retained Netflix password in self-service mode", () => {
  const selfServiceOrder = {
    ...order,
    netflixDeliveryMode: "self_service",
    deliveryMessageMode: "auto",
    staffNotes: "旧说明：请使用 retained-internal-password 登录",
    items: order.items.map((item) => ({
      ...item,
      staffAccount: "netflix-login@example.com",
      staffPassword: "retained-internal-password",
    })),
  };
  const result = buildReferenceNotificationEmail({
    orders: [selfServiceOrder],
    subject: "Netflix 登录资料更新",
    message: "请查看最新登录资料。",
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    locale: "zh",
  });
  assert.match(result.html, /Netflix 登录邮箱/);
  assert.match(result.html, /netflix-login@example\.com/);
  assert.doesNotMatch(result.html, /retained-internal-password/);
  assert.match(result.text, /Netflix 登录邮箱: netflix-login@example\.com/);
  assert.doesNotMatch(result.text, /retained-internal-password/);
  assert.doesNotMatch(result.html, /旧说明/);
});

test("reference notice scrubs password-era custom copy for legacy Netflix service shapes", () => {
  const selfServiceOrder = {
    ...order,
    service: "NETFLIX",
    password: "top-buyer-password",
    staffPassword: "top-staff-password",
    netflixDeliveryMode: "self_service",
    deliveryMessageMode: "custom",
    staffNotes: "Temporary password: top-buyer-password",
    items: [{
      ...order.items[0],
      service: "   ",
      password: "item-buyer-password",
      staffAccount: "legacy-shape@example.com",
      staffPassword: "retained-internal-password",
    }],
  };
  const result = buildReferenceNotificationEmail({
    orders: [selfServiceOrder],
    subject: "Password retained-internal-password",
    message: "Use retained-internal-password\nUse item-buyer-password\nUse top-staff-password\nUse top-buyer-password\nThe order details have been updated.",
    brandName: "Maoyang",
    siteDomain: "www.liumeiti.vip",
    locale: "en",
  });

  assert.equal(result.subject, "Order service update");
  assert.match(`${result.html}\n${result.text}`, /legacy-shape@example\.com/);
  assert.match(`${result.html}\n${result.text}`, /The order details have been updated/);
  assert.doesNotMatch(`${result.html}\n${result.text}`, /retained-internal-password|item-buyer-password|top-staff-password|top-buyer-password|Temporary password/);
});

test("reference notice preserves legacy no-items staff credentials and subscription links", () => {
  const legacy = {
    orderId: "LMLEGACYROCKET1",
    service: "rocket",
    serviceLabel: "机场节点",
    cycle: "1年",
    account: "buyer-legacy",
    password: "buyer-password",
    staffAccount: "staff-legacy",
    staffPassword: "staff-password",
    subscriptionLinks: {
      shadowrocket: "https://example.com/sub/staff-legacy",
      clash: "https://example.com/sub/staff-legacy?format=clash",
    },
  };
  const result = buildReferenceNotificationEmail({
    orders: [legacy],
    subject: "服务资料更新",
    message: "请使用最新资料。",
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    locale: "zh",
  });
  assert.match(result.html, /staff-legacy/);
  assert.match(result.html, /staff-password/);
  assert.match(result.html, /format=clash/);
  assert.doesNotMatch(result.html, /buyer-password/);
  assert.match(result.text, /staff-legacy/);
  assert.match(result.text, /format=clash/);
});
