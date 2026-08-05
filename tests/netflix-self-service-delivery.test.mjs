import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildCompletionEmailHtml, buildCompletionEmailText } from "../app/api/order/completion-email.js";
import { getGuide, localizeGuide } from "../app/guides/guides-data.js";
import { getServiceBySlug, localizeService } from "../app/services/service-data.js";
import { eligibleNetflixCodeOrder } from "../app/netflix-code/order-eligibility.js";
import { netflixUserStatesByOwner } from "../app/api/order-query/route.js";
import { buildDeliveryMessage } from "../app/lib/order-fulfillment.js";
import { publicNetflixStaffNotes } from "../app/lib/netflix-delivery.js";

const ROOT = new URL("../", import.meta.url);

function netflixOrder(deliveryMode, operationalEnabled) {
  return {
    orderId: "LMNETFLIXDELIVERY1",
    status: "completed",
    locale: "zh",
    netflixDeliveryMode: deliveryMode,
    ...(operationalEnabled === undefined ? {} : { netflixSelfServiceEnabled: operationalEnabled }),
    deliveryMessageMode: "auto",
    staffNotes: "请前往 https://www.liumeiti.vip/netflix-code 获取登录码",
    completedAtBeijing: "2026/08/05 20:30:00",
    items: [{
      service: "netflix",
      label: "Netflix · 单独车位",
      cycle: "1年",
      staffAccount: "netflix-login@example.com",
      staffPassword: "stored-password",
    }],
  };
}

test("admin Netflix delivery mode is one compact accessible switch beside the credentials", async () => {
  const [page, workbench, css, orderRoute, codePanel] = await Promise.all([
    readFile(new URL("app/admin/page.jsx", ROOT), "utf8"),
    readFile(new URL("app/admin/DeliveryWorkbench.jsx", ROOT), "utf8"),
    readFile(new URL("app/globals.css", ROOT), "utf8"),
    readFile(new URL("app/api/order/route.js", ROOT), "utf8"),
    readFile(new URL("app/admin/NetflixCodePanel.jsx", ROOT), "utf8"),
  ]);
  assert.match(page, /isFirstNetflix/);
  assert.match(page, /role="switch"/);
  assert.match(page, /aria-checked=\{netflixSelfServiceEnabled\}/);
  assert.match(page, /aria-label="切换 Netflix 交付方式"/);
  assert.match(page, /自助接码/);
  assert.match(page, /手动账号密码/);
  assert.match(page, /客服填写登录邮箱/);
  assert.match(page, /href="\/netflix-code" target="_blank" rel="noopener noreferrer"/);
  assert.match(page, /netflixOperationalEnabled/);
  assert.match(page, /接码已暂停 · 点击恢复/);
  assert.match(page, /completion_netflix_user_state_unavailable/);
  assert.match(page, /deliveryMessageMode: "auto"/);
  assert.match(page, /netflixDeliveryMode = enabled \? "self_service" : "password"/);
  assert.doesNotMatch(workbench, /允许 Netflix 自助接码|onNetflixSelfServiceChange/);
  assert.match(css, /\.admin-netflix-self-service/);
  assert.match(orderRoute, /netflixDeliveryMode: items\.some\(\(item\) => item\.service === "netflix"\) \? "self_service" : undefined/);
  assert.match(codePanel, /order\.deliveryMode === "password"/);
  assert.match(codePanel, /手动密码交付/);
  assert.match(codePanel, /暂停订单接码/);
});

test("after-sales editor writes back a self-service Netflix email without requesting its retained password", async () => {
  const panel = await readFile(new URL("app/admin/AfterSalesPanel.jsx", ROOT), "utf8");
  assert.match(panel, /item\.netflixSelfService === true/);
  assert.match(panel, /Netflix 登录邮箱/);
  assert.match(panel, /item\.apply && item\.netflixSelfService && !validEmail\(item\.account\)/);
  assert.match(panel, /item\.apply && !item\.netflixSelfService && \(!item\.account\.trim\(\) \|\| !item\.password\.trim\(\)\)/);
  assert.match(panel, /required=\{draft\.apply\}/);
  assert.match(panel, /!netflixSelfService && <label>/);
  assert.match(panel, /自助接码订单只同步登录邮箱，不显示或改写订单内保留的密码/);
  assert.doesNotMatch(panel, /autoComplete="new-password" required disabled/);
});

test("completion email offers a clickable Netflix code entry only when online retrieval is enabled", () => {
  const enabledHtml = buildCompletionEmailHtml({
    order: netflixOrder("self_service"),
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "zh",
  });
  const enabledText = buildCompletionEmailText({
    order: netflixOrder("self_service"),
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "zh",
  });
  assert.match(enabledHtml, /href="https:\/\/www\.liumeiti\.vip\/netflix-code"/);
  assert.match(enabledHtml, /在线获取 Netflix 登录码/);
  assert.match(enabledText, /在线获取 Netflix 登录码: https:\/\/www\.liumeiti\.vip\/netflix-code/);
  assert.doesNotMatch(enabledHtml, /stored-password/);
  assert.doesNotMatch(enabledText, /stored-password/);

  const disabledHtml = buildCompletionEmailHtml({
    order: netflixOrder("password"),
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "zh",
  });
  assert.doesNotMatch(disabledHtml, /href="https:\/\/www\.liumeiti\.vip\/netflix-code"/);
  assert.match(disabledHtml, /stored-password/);

  const pausedOrder = netflixOrder("self_service", false);
  pausedOrder.locale = "en";
  pausedOrder.items[0].fulfillment = { profileNumber: "3", pin: "7391", loginHelp: true };
  pausedOrder.staffNotes = buildDeliveryMessage(pausedOrder, pausedOrder.items, false);
  const pausedHtml = buildCompletionEmailHtml({
    order: pausedOrder,
    brandName: "冒央会社",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "zh",
  });
  const pausedText = buildCompletionEmailText({
    order: pausedOrder,
    brandName: "Maoyang",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "en",
  });
  assert.doesNotMatch(pausedHtml, /href="https:\/\/www\.liumeiti\.vip\/netflix-code"/);
  assert.doesNotMatch(pausedHtml, /stored-password/);
  assert.doesNotMatch(pausedHtml, /请前往 https:\/\/www\.liumeiti\.vip\/netflix-code/);
  assert.match(pausedHtml, /在线获取登录码暂不可用/);
  assert.match(`${pausedHtml}\n${pausedText}`, /Use profile number 3/);
  assert.match(`${pausedHtml}\n${pausedText}`, /Profile PIN: 7391/);
  assert.doesNotMatch(pausedText, /www\.liumeiti\.vip\/netflix-code/);
});

test("Netflix guide links to the code page with customer-facing Chinese and English copy", () => {
  const guide = getGuide("netflix-4k-seat-vs-full-account");
  const enGuide = localizeGuide(guide, "en");
  const zhText = JSON.stringify({ steps: guide.steps, faq: guide.faq });
  const enText = JSON.stringify({ steps: enGuide.steps, faq: enGuide.faq });
  assert.equal(guide.updated, "2026-08-05");
  assert.equal(guide.steps.flatMap(([, body]) => body?.parts || []).some((part) => part?.href === "/netflix-code"), true);
  assert.equal(enGuide.steps.flatMap(([, body]) => body?.parts || []).some((part) => part?.href === "/netflix-code"), true);
  assert.match(zhText, /在线获取登录码|Netflix 登录码页面/);
  assert.match(enText, /online sign-in code retrieval|Netflix Sign-in Code page/);
  assert.doesNotMatch(`${zhText}${enText}`, /转发规则|邮件解析|codes\.liumeiti\.vip|后台接口/);
});

test("Netflix service FAQ matches the two delivery modes in both locales", () => {
  const service = getServiceBySlug("netflix");
  const enService = localizeService(service, "en");
  assert.match(JSON.stringify(service.faq), /订单如标注支持在线获取登录码/);
  assert.match(JSON.stringify(enService.faq), /supports online sign-in code retrieval/);
});

test("customer order projections expose effective online-code availability and both order views render one entry", async () => {
  const [meRoute, queryRoute, accountPage, serviceCenterPage, codeRoute, adminCodeRoute] = await Promise.all([
    readFile(new URL("app/api/auth/me/route.js", ROOT), "utf8"),
    readFile(new URL("app/api/order-query/route.js", ROOT), "utf8"),
    readFile(new URL("app/account/page.jsx", ROOT), "utf8"),
    readFile(new URL("app/service-center/page.jsx", ROOT), "utf8"),
    readFile(new URL("app/api/netflix-code/route.js", ROOT), "utf8"),
    readFile(new URL("app/api/admin/netflix-code/route.js", ROOT), "utf8"),
  ]);
  assert.match(meRoute, /netflixDeliveryMode !== "password"[\s\S]*order\.netflixSelfServiceEnabled !== false/);
  assert.match(queryRoute, /netflixDeliveryMode !== "password"[\s\S]*order\.netflixSelfServiceEnabled !== false/);
  assert.match(meRoute, /new Set\(netflixAccounts\)\.size === 1/);
  assert.match(queryRoute, /new Set\(netflixAccounts\)\.size === 1/);
  assert.match(meRoute, /const service = orderItemService\(order, it, index\)[\s\S]*service === "netflix" && netflixSelfServiceDelivery[\s\S]*\? ""/);
  assert.match(queryRoute, /const service = orderItemService\(order, it, index\)[\s\S]*service === "netflix" && netflixSelfServiceDelivery[\s\S]*\? ""/);
  assert.match(meRoute, /publicNetflixStaffNotes/);
  assert.match(queryRoute, /publicNetflixStaffNotes/);
  assert.match(accountPage, /activeOrder\.netflixSelfServiceEnabled !== false/);
  assert.match(accountPage, /activeOrder\.items\.some\(\(item\) => item\.service === "netflix"\)/);
  assert.match(serviceCenterPage, /queryDetailOrder\.netflixSelfServiceEnabled !== false/);
  assert.match(serviceCenterPage, /queryItems\.some\(\(item\) => item\.service === "netflix"\)/);
  assert.match(codeRoute, /hasStoredDeliveryMode && storedDeliveryMode !== "self_service"/);
  assert.match(adminCodeRoute, /entry\.order\.netflixSelfServiceEnabled = body\.enabled !== false/);
  assert.doesNotMatch(adminCodeRoute, /entry\.order\.netflixDeliveryMode = body\.enabled/);
  assert.match(accountPage, /在线获取 Netflix 登录码/);
  assert.match(codeRoute, /index === 0 \? order\?\.staffAccount \|\| order\?\.account : ""/);
});

test("Netflix code page hides manual, paused, expired, and invalid order shapes before authorization", () => {
  const base = {
    status: "completed",
    netflixSelfServiceEnabled: true,
    items: [{ service: "netflix" }],
    expiry: { expired: false },
  };
  assert.equal(eligibleNetflixCodeOrder(base), true);
  assert.equal(eligibleNetflixCodeOrder({ ...base, netflixSelfServiceEnabled: false }), false);
  assert.equal(eligibleNetflixCodeOrder({ ...base, netflixSelfServiceEnabled: undefined }), false);
  assert.equal(eligibleNetflixCodeOrder({ ...base, expiry: { expired: true } }), false);
  assert.equal(eligibleNetflixCodeOrder({ ...base, status: "invalid" }), false);
  assert.equal(eligibleNetflixCodeOrder({ ...base, items: [{ service: "spotify" }] }), false);
  assert.equal(eligibleNetflixCodeOrder({ ...base, items: [{ service: "Netflix" }] }), true);
  assert.equal(eligibleNetflixCodeOrder({ ...base, service: "NETFLIX", items: [{ service: "" }] }), true);
  assert.equal(eligibleNetflixCodeOrder({ ...base, service: " Netflix ", items: [{ service: "   " }] }), true);
});

test("legacy service shapes still generate self-service instructions without publishing retained secrets", () => {
  const order = netflixOrder("self_service");
  order.locale = "en";
  order.service = "NETFLIX";
  order.items[0].service = "   ";
  order.items[0].password = "item-buyer-password";
  order.staffPassword = "top-staff-password";
  order.password = "top-buyer-password";
  order.staffNotes = [
    `Staff password: ${order.items[0].staffPassword}`,
    `Buyer password: ${order.items[0].password}`,
    `Top staff password: ${order.staffPassword}`,
    `Top buyer password: ${order.password}`,
    "Open the Netflix code page.",
  ].join("\n");

  const message = buildDeliveryMessage(order, order.items, false);
  const html = buildCompletionEmailHtml({
    order,
    brandName: "Maoyang",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "en",
  });
  const text = buildCompletionEmailText({
    order,
    brandName: "Maoyang",
    siteDomain: "www.liumeiti.vip",
    siteUrl: "https://www.liumeiti.vip",
    locale: "en",
  });

  assert.match(message, /https:\/\/www\.liumeiti\.vip\/netflix-code/);
  assert.doesNotMatch(message, /login email and password are included/i);
  assert.match(html, /href="https:\/\/www\.liumeiti\.vip\/netflix-code"/);
  assert.doesNotMatch(`${html}\n${text}`, /stored-password|item-buyer-password|top-staff-password|top-buyer-password/);
  assert.match(`${html}\n${text}`, /Open the Netflix code page/);
});

test("self-service customer notes suppress custom password-era text and scrub auto notes", () => {
  const custom = netflixOrder("self_service");
  custom.deliveryMessageMode = "custom";
  custom.staffNotes = "Temporary password: stored-password";
  assert.equal(publicNetflixStaffNotes(custom), "");

  const automatic = netflixOrder("self_service");
  automatic.deliveryMessageMode = "auto";
  automatic.items[0].password = "item-buyer-password";
  automatic.staffPassword = "top-staff-password";
  automatic.password = "top-buyer-password";
  automatic.staffNotes = [
    "Profile 2",
    "Password: stored-password",
    "Buyer: item-buyer-password",
    "Top staff: top-staff-password",
    "Top buyer: top-buyer-password",
    "Open the code page",
  ].join("\n");
  assert.equal(publicNetflixStaffNotes(automatic), "Profile 2\nOpen the code page");

  const paused = netflixOrder("self_service", false);
  paused.locale = "en";
  paused.items[0].fulfillment = { profileNumber: "3", pin: "7391", loginHelp: true };
  paused.staffNotes = buildDeliveryMessage(paused, paused.items, false);
  const pausedNotes = publicNetflixStaffNotes(paused, { onlineCodeAvailable: false });
  assert.match(pausedNotes, /Use profile number 3/);
  assert.match(pausedNotes, /Profile PIN: 7391/);
  assert.doesNotMatch(pausedNotes, /netflix-code|sign-in code or identity confirmation/i);
});

test("order-query reads Netflix user state once per unique eligible owner", async () => {
  const calls = [];
  const orders = [
    { orderId: "A", email: "same@example.com", netflixDeliveryMode: "self_service", items: [{ service: "netflix" }] },
    { orderId: "B", email: "same@example.com", items: [{ service: "netflix" }] },
    { orderId: "C", email: "other@example.com", netflixDeliveryMode: "self_service", items: [{ service: "netflix" }] },
    { orderId: "D", email: "manual@example.com", netflixDeliveryMode: "password", items: [{ service: "netflix" }] },
    { orderId: "E", email: "invalid@example.com", netflixDeliveryMode: "unexpected", items: [{ service: "netflix" }] },
    { orderId: "F", email: "paused@example.com", netflixSelfServiceEnabled: false, items: [{ service: "netflix" }] },
    { orderId: "G", email: "spotify@example.com", items: [{ service: "spotify" }] },
  ];
  const states = await netflixUserStatesByOwner(orders, async (email) => {
    calls.push(email);
    return { ok: true, user: { email } };
  });
  assert.deepEqual(calls.sort(), ["other@example.com", "same@example.com"]);
  assert.equal(states.size, 2);
});

test("guest verification path uses the same Netflix eligibility helper as signed-in orders", async () => {
  const page = await readFile(new URL("app/netflix-code/page.jsx", ROOT), "utf8");
  assert.doesNotMatch(page, /filter\(eligibleOrder\)/);
  assert.equal((page.match(/filter\(eligibleNetflixCodeOrder\)/g) || []).length, 2);
  assert.match(page, /netflix_account_conflict/);
});
