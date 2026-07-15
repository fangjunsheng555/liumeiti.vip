import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "quote-notice-test-secret-at-least-32-chars";

const quoteExpiry = await import("../app/api/_quote-expiry.js");
const serviceNotices = await import("../app/api/_service-notices.js");
const { buildProxyOrderEmail } = await import("../app/api/quote-orders/_email.js");
const { buildServiceNoticeEmail } = await import("../app/api/service-notices/_email.js");
const { buildInvalidOrderEmailHtml } = await import("../app/api/order/invalid-email.js");

test("quote validity accepts only supported options and defaults to seven days", () => {
  assert.equal(quoteExpiry.normalizeQuoteValidDays(1), 1);
  assert.equal(quoteExpiry.normalizeQuoteValidDays("14"), 14);
  assert.equal(quoteExpiry.normalizeQuoteValidDays(2), 7);
  assert.equal(quoteExpiry.normalizeQuoteValidDays("bad"), 7);
});

test("quote expiry changes only due proxy-payment quotes and is idempotent", () => {
  const deadline = Date.UTC(2026, 6, 13, 8, 0, 0);
  const order = {
    orderId: "LMQUOTE1",
    orderType: "proxy_payment",
    status: "pending_payment",
    quoteExpiresAt: new Date(deadline).toISOString(),
  };
  assert.equal(quoteExpiry.effectiveQuoteStatus(order, deadline - 1), "pending_payment");
  assert.equal(quoteExpiry.effectiveQuoteStatus(order, deadline), "quote_expired");
  quoteExpiry.applyQuoteExpiry(order, new Date(deadline));
  assert.equal(order.status, "quote_expired");
  assert.equal(order.staffAudit.length, 1);
  quoteExpiry.applyQuoteExpiry(order, new Date(deadline + 1000));
  assert.equal(order.staffAudit.length, 1);
  assert.equal(quoteExpiry.effectiveQuoteStatus({ ...order, orderType: "standard", status: "pending_payment" }, deadline), "pending_payment");
});

test("quote email uses the stored payment deadline instead of fixed copy", () => {
  const email = buildProxyOrderEmail({
    kind: "quote",
    order: {
      orderId: "LMQUOTE2",
      quoteAmount: 400,
      platformUrl: "https://example.com/item",
      productPrice: "USD 99",
      quoteExpiresAtBeijing: "2026-07-20 18:30:00 北京时间 (UTC+8)",
    },
    paymentUrl: "https://www.liumeiti.vip/checkout/quote/LMQUOTE2#token=test",
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "zh",
  });
  assert.match(email.html, /付款截止/);
  assert.match(email.html, /2026-07-20 18:30:00/);
  assert.doesNotMatch(email.html, /付款链接 7 天内有效/);
  assert.match(email.text, /付款截止: 2026-07-20/);
  assert.match(email.html, /点击下方按钮进入专属付款页面/);
  assert.doesNotMatch(email.html, /通过专属链接完成付款/);
  const emailEn = buildProxyOrderEmail({
    kind: "quote",
    order: {
      orderId: "LMQUOTE2EN",
      quoteAmount: 400,
      platformUrl: "https://example.com/item",
      productPrice: "USD 99",
    },
    paymentUrl: "https://www.liumeiti.vip/checkout/quote/LMQUOTE2EN#token=test",
    brandName: "Maoyang Taiwan Inc.",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "en",
  });
  assert.match(emailEn.html, /use the button below to open your secure payment page/);
});

test("service notice audience keeps current paid users, excludes expired orders and deduplicates email", () => {
  const now = Date.UTC(2026, 6, 13, 0, 0, 0);
  const orders = [
    {
      orderId: "LM1", status: "completed", email: "same@example.com", locale: "zh",
      completedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      items: [{ service: "spotify", cycle: "1年" }],
    },
    {
      orderId: "LM2", status: "received", email: "same@example.com", locale: "en",
      createdAt: new Date(Date.UTC(2026, 6, 12)).toISOString(),
      items: [{ service: "spotify", cycle: "1年" }],
    },
    {
      orderId: "LM3", status: "completed", email: "expired@example.com", locale: "zh",
      completedAt: new Date(Date.UTC(2024, 0, 1)).toISOString(),
      items: [{ service: "spotify", cycle: "1年" }],
    },
    {
      orderId: "LM4", status: "completed", email: "other@example.com", locale: "zh",
      completedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      items: [{ service: "netflix", cycle: "1年" }],
    },
    {
      orderId: "LM5", status: "invalid", email: "invalid@example.com", locale: "zh",
      items: [{ service: "spotify", cycle: "1年" }],
    },
  ];
  const audience = serviceNotices.buildServiceNoticeAudience(orders, "spotify", now);
  assert.equal(audience.length, 1);
  assert.equal(audience[0].email, "same@example.com");
  assert.equal(audience[0].locale, "en");
  assert.deepEqual(audience[0].orderIds.sort(), ["LM1", "LM2"]);
  assert.deepEqual(serviceNotices.serviceNoticeAudienceSummary(audience), { total: 1, zh: 0, en: 1 });
});

test("service notice email stays transactional and links to the announcement center", () => {
  const email = buildServiceNoticeEmail({
    post: {
      title: "Spotify 服务说明",
      titleEn: "Spotify service update",
      body: "部分订单可能短时无法登录。\n我们正在处理。",
      bodyEn: "Some orders may have a temporary sign-in issue.\nWe are working on it.",
      published: true,
    },
    service: "spotify",
    serviceLabel: "Spotify",
    locale: "zh",
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
  });
  assert.match(email.subject, /Spotify 服务通知/);
  assert.match(email.html, /部分订单可能短时无法登录。<br>我们正在处理。/);
  assert.match(email.html, /https:\/\/www\.liumeiti\.vip\/announcements/);
  assert.match(email.html, /关于您使用的Spotify服务，有一项重要更新。/);
  assert.match(email.html, /点击下方按钮查看完整公告。/);
  assert.doesNotMatch(email.html, /立即购买|限时|优惠/);
});

test("invalid-order email clearly points customers to the order button", () => {
  const html = buildInvalidOrderEmailHtml({
    order: {
      orderId: "LMINVALID1",
      serviceLabel: "Spotify",
      cycle: "1年",
      finalAmount: 128,
    },
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "zh",
  });
  assert.match(html, /点击下方按钮可查看订单详情与当前状态。/);
  assert.match(html, /订单通知/);
});
