import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKETING_MAIL_SUBJECT,
  buildMarketingMailHtml,
  buildMarketingMailText,
} from "../app/api/admin/mail/marketing-template.js";

const products = [
  ["spotify", "Spotify", "¥128/年起", "spotify.jpg", "spotify"],
  ["rocket", "机场节点", "¥128/年起", "rocket.jpg", "airport-node"],
  ["ai", "AI 会员", "¥229/三个月起", "ai.jpg", "ai"],
  ["netflix", "Netflix", "¥168/年起", "netflix.jpg", "netflix"],
  ["disney", "Disney+", "¥108/年起", "disney.jpg", "disney"],
  ["max", "HBO Max", "¥148/年起", "hbomax.jpg", "hbo-max"],
  ["proxy-pay", "全球代付", "3折起", "proxy-pay.jpg", "proxy-payment"],
].map(([key, name, price, icon, slug]) => ({ key, name, price, icon, href: `https://www.liumeiti.vip/services/${slug}` }));

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
