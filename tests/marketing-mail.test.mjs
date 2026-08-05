import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKETING_MAIL_SUBJECT,
  buildMarketingMailHtml,
  buildMarketingMailText,
} from "../app/api/admin/mail/marketing-template.js";
import {
  buildMarketingMailV7Html,
  buildMarketingMailV7Text,
  normalizeMarketingOffer,
  sanitizeMarketingMailHtml,
} from "../app/api/admin/mail/marketing-template-v7.js";

const products = [
  ["spotify", "Spotify", "¥128/年起", "spotify.jpg", "spotify"],
  ["rocket", "机场节点", "¥108/年起", "rocket.jpg", "airport-node"],
  ["ai", "AI 会员", "¥229/三个月起", "ai.jpg", "ai"],
  ["netflix", "Netflix", "¥168/年起", "netflix.jpg", "netflix"],
  ["disney", "Disney+", "¥108/年起", "disney.jpg", "disney"],
  ["max", "HBO Max", "¥148/年起", "hbomax.jpg", "hbo-max"],
  ["proxy-pay", "全球代付", "3折起", "proxy-pay.jpg", "proxy-payment"],
].map(([key, name, price, icon, slug]) => ({ key, name, price, icon, href: `https://www.liumeiti.vip/services/${slug}` }));

test("legacy marketing HTML sanitizer blocks encoded active content and keeps safe email markup", () => {
  const html = sanitizeMarketingMailHtml(`
    <style>@media (max-width:600px){.card{width:100%}}</style>
    <table role="presentation" style="width:100%;background:url(https://www.liumeiti.vip/email-bg.png)">
      <tr><td>
        <a href="https://www.liumeiti.vip/shop?from=mail">SAFE-LINK</a>
        <img src="https://www.liumeiti.vip/email-logo.png" alt="SAFE-IMAGE">
        <img src="data:image/png;base64,iVBORw0KGgo=" alt="SAFE-INLINE-RASTER">
        <a href="java&#x73;cript:alert(1)">BAD-ENTITY-PROTOCOL</a>
        <img src="data:image/svg+xml,<svg onload=alert(2)>" alt="BAD-SVG-DATA">
        <div style="background-image:url(javascript:alert(3))">BAD-CSS-URL</div>
        <img src="https://www.liumeiti.vip/safe.png" o&#x6e;error="alert(4)" alt="BAD-ENCODED-EVENT">
        <meta http-equiv="refresh" content="0;url=javascript:alert(5)">
        <link rel="stylesheet" href="https://outside.example/style.css">
        <audio autoplay src="https://outside.example/sound.mp3">BAD-AUDIO</audio>
        <video autoplay src="https://outside.example/video.mp4"><source src="https://outside.example/video-alt.mp4"></video>
      </td></tr>
    </table>
  `);

  assert.match(html, /<style>@media \(max-width:600px\)/);
  assert.match(html, /role="presentation"/);
  assert.match(html, /href="https:\/\/www\.liumeiti\.vip\/shop\?from=mail"/);
  assert.match(html, /src="https:\/\/www\.liumeiti\.vip\/email-logo\.png"/);
  assert.match(html, /src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.doesNotMatch(html, /javascript:|data:image\/svg\+xml|\bonerror\s*=|background-image:url\(|<\/?(?:meta|link|audio|video|source|track)\b/i);
  assert.equal((html.match(/(?:href|src)="#"/g) || []).length, 2);
});

test("marketing mail follows service priority and live catalog prices", () => {
  const html = buildMarketingMailHtml({ brandName: "冒央会社", siteUrl: "https://www.liumeiti.vip", products });
  assert.match(MARKETING_MAIL_SUBJECT, /让音乐更尽兴，让连接更稳定/);
  for (const product of products) {
    assert.match(html, new RegExp(product.name.replace("+", "\\+")));
    assert.match(html, new RegExp(product.price.replace("+", "\\+")));
  }
  assert.ok(html.indexOf("Spotify 与稳定高速节点") < html.indexOf("从高效工作到 4K 影音"));
  assert.doesNotMatch(html, /主推|重点推荐|同步开放|实时目录|订单进度可查询|售后工单可追踪|按需求选规格/);
  assert.doesNotMatch(html, /付款秒开通|全网最低价|官方渠道/);
  assert.match(html, /服务中心/);
});

test("plain text fallback contains all service links without stale prices", () => {
  const text = buildMarketingMailText({ brandName: "冒央会社", siteUrl: "https://www.liumeiti.vip", products });
  assert.match(text, /AI 会员｜¥229\/三个月起/);
  assert.match(text, /HBO Max｜¥148\/年起/);
  assert.match(text, /全球代付｜3折起/);
  assert.doesNotMatch(text, /¥198\/三个月起/);
});

test("v7 marketing template derives products and prices from the catalog, not legacy promotion fields", () => {
  const offer = {
    badge: "八月精选",
    headline: "按需要选择合适的数字服务",
    description: "当前可用方案、价格和服务周期可在商品页查看。",
    // Historical clients and queued snapshots may still send these fields. They
    // must remain request-compatible, but they are not a source of checkout truth.
    originalPrice: "¥99999",
    currentPrice: "手填活动价-一元",
    savingText: "立省 ¥99998",
    couponCode: "LEGACY-NOT-A-REAL-DISCOUNT",
    deadlineText: "LEGACY-FAKE-DEADLINE",
    ctaLabel: "查看当前服务",
    ctaPath: "/shop",
    featuredServiceKeys: ["spotify", "netflix"],
  };
  const benefits = { bundleTier2Label: "95 折", bundleTier3Label: "9 折", usdtDiscountLabel: "9 折" };
  const html = buildMarketingMailV7Html({ brandName: "冒央会社", siteUrl: "https://www.liumeiti.vip", products, benefits, offer });
  const text = buildMarketingMailV7Text({ brandName: "冒央会社", siteUrl: "https://www.liumeiti.vip", products, benefits, offer });
  const normalized = normalizeMarketingOffer({
    badge: "本期服务",
    headline: "当前方案",
    description: "从目录选择。",
    featuredServiceKeys: ["spotify", "netflix"],
    ctaLabel: "查看服务",
    ctaPath: "/shop",
  });

  assert.deepEqual(normalized.featuredServiceKeys, ["spotify", "netflix"]);
  for (const legacyField of ["couponCode", "originalPrice", "currentPrice", "savingText"]) {
    assert.equal(Object.hasOwn(normalized, legacyField), false);
  }

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<table role="presentation"/);
  assert.match(html, /style="[^"]+"/);
  assert.equal((html.match(/<table\b/g) || []).length, (html.match(/<table\b[^>]*\bcellspacing="0"[^>]*\bcellpadding="0"[^>]*\bborder="0"/g) || []).length);
  assert.doesNotMatch(html, /<script|<form|<input|\son[a-z]+=/i);
  assert.doesNotMatch(html, /<style\b/i);
  for (const value of ["八月精选", "按需要选择合适的数字服务", "Spotify", "¥128/年起", "Netflix", "¥168/年起"]) {
    assert.match(html, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(html, /href="https:\/\/www\.liumeiti\.vip\/shop"/);
  assert.match(html, /href="https:\/\/www\.liumeiti\.vip\/services\/spotify"/);
  assert.match(html, /href="https:\/\/www\.liumeiti\.vip\/services\/netflix"/);
  assert.match(text, /https:\/\/www\.liumeiti\.vip\/shop/);
  assert.match(text, /https:\/\/www\.liumeiti\.vip\/services\/spotify/);
  assert.match(text, /https:\/\/www\.liumeiti\.vip\/services\/netflix/);
  for (const value of ["同时选购", "95 折", "9 折", "USDT", "无需额外操作", "结算优惠自动计算"]) {
    assert.match(html, new RegExp(value));
    assert.match(text, new RegExp(value));
  }
  for (const invented of ["¥99999", "手填活动价-一元", "立省 ¥99998", "LEGACY-NOT-A-REAL-DISCOUNT", "LEGACY-FAKE-DEADLINE"]) {
    assert.doesNotMatch(html, new RegExp(invented.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(text, new RegExp(invented.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(html, /优惠码|原价\s*(?:<|[：:])|活动价\s*(?:<|[：:])|DIGITAL MEMBERSHIP DESK|WHY IT MATTERS|RECOMMENDED FOR YOU/i);
  assert.doesNotMatch(text, /优惠码|原价[：:]|活动价[：:]|DIGITAL MEMBERSHIP DESK|WHY IT MATTERS|RECOMMENDED FOR YOU/i);
  assert.doesNotMatch(html, /机场节点|AI 会员|Disney\+|HBO Max|全球代付/);
  assert.doesNotMatch(text, /机场节点|AI 会员|Disney\+|HBO Max|全球代付/);
  assert.doesNotMatch(text, /<[^>]+>/);
});

test("v7 keeps legacy serviceKeys only as a featured-product compatibility fallback", () => {
  const html = buildMarketingMailV7Html({
    brandName: "冒央会社",
    siteUrl: "https://www.liumeiti.vip",
    products,
    benefits: { bundleTier2Label: "95 折", bundleTier3Label: "9 折", usdtDiscountLabel: "9 折" },
    offer: { serviceKeys: ["netflix"], ctaPath: "/shop" },
  });
  assert.match(html, /Netflix/);
  assert.doesNotMatch(html, /Spotify|机场节点|AI 会员|Disney\+|HBO Max|全球代付/);
});

test("v7 output cleans markup and incomplete catalog fields from recipient-visible copy", () => {
  const args = {
    brandName: "<script>badBrand()</script>冒央会社",
    siteUrl: "https://www.liumeiti.vip",
    products: [
      { key: "missing", href: "https://evil.example/steal" },
      { key: "hostile", name: "<img src=x>AI 会员", subtitle: "<svg>badSubtitle()</svg>按当前规格选择", price: "<b>¥198</b>", href: "javascript:alert(1)" },
    ],
    offer: {
      headline: "<script>alert(1)</script>服务精选",
      badge: "<style>badBadge()</style>本期服务",
      description: {},
      ctaLabel: "<img src=x>查看服务",
      featuredServiceKeys: ["missing", "hostile"],
    },
  };
  const text = buildMarketingMailV7Text(args);
  const html = buildMarketingMailV7Html(args);

  for (const output of [text, html]) {
    assert.doesNotMatch(output, /undefined|\[object Object\]|evil\.example|javascript:|bad(?:Brand|Subtitle|Badge|Description)|alert\(1\)/i);
  }
  assert.doesNotMatch(text, /<[^>]*>/);
  assert.doesNotMatch(html, /&lt;(?:script|img|svg|style|math)\b/i);
  assert.match(text, /数字服务｜查看当前价格/);
  assert.match(text, /AI 会员｜¥198/);
  assert.match(html, /本期服务|服务精选|按当前规格选择|¥198/);
  assert.equal((text.match(/https:\/\/www\.liumeiti\.vip\/shop/g) || []).length >= 2, true);
});
