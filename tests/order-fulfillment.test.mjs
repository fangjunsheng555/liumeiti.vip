import test from "node:test";
import assert from "node:assert/strict";

import {
  THIRD_PARTY_NOTICE_ZH,
  applyThirdPartyNotice,
  buildDeliveryMessage,
  hasThirdPartyNotice,
  itemValidityLabel,
  normalizeFulfillment,
} from "../app/lib/order-fulfillment.js";

test("Spotify delivery message uses the existing order expiry calculation", () => {
  const item = {
    service: "spotify",
    label: "Spotify · 家庭成员",
    cycle: "1年",
    plan: "member",
    fulfillment: {
      username: "Mia",
      region: "europe",
      outcome: "family_joined",
      emailConfirmation: false,
    },
  };
  const order = {
    status: "completed",
    locale: "zh",
    completedAt: "2026-07-27T10:00:00.000Z",
    items: [item],
  };
  assert.equal(itemValidityLabel(order, item), "有效期至 2027-07-27");
  const message = buildDeliveryMessage(order);
  assert.equal(message.startsWith("Spotify 用户名：Mia，所属地区为欧洲区。"), true);
  assert.doesNotMatch(message, /。，/);
  assert.match(message, /欧洲区/);
  assert.match(message, /有效期至 2027-07-27/);
  assert.match(message, /账号与密码已随订单交付/);
  assert.match(message, /支持无损音质、播客及其他会员功能/);
  assert.doesNotMatch(message, /登录资料请在订单详情中查看/);
});

test("unfinished orders show their purchased cycle instead of inventing an expiry date", () => {
  const item = {
    service: "rocket",
    label: "机场节点 · 普通套餐",
    cycle: "1年",
    plan: "basic",
    fulfillment: { clientGuide: true },
  };
  const order = {
    status: "received",
    locale: "zh",
    createdAt: "2026-07-27T10:00:00.000Z",
    items: [item],
  };
  assert.equal(itemValidityLabel(order, item), "有效期：1年");
  assert.match(buildDeliveryMessage(order), /有效期：1年/);
});

test("third-party notice toggle appends the exact copy once and removes it cleanly", () => {
  const enabled = applyThirdPartyNotice("服务已开通。", true, "zh");
  assert.equal(enabled, `服务已开通。\n\n${THIRD_PARTY_NOTICE_ZH}`);
  assert.equal(applyThirdPartyNotice(enabled, true, "zh"), enabled);
  assert.equal(hasThirdPartyNotice(enabled), true);
  assert.equal(applyThirdPartyNotice(enabled, false, "zh"), "服务已开通。");
});

test("fulfillment input is restricted to service-specific fields", () => {
  assert.deepEqual(normalizeFulfillment("netflix", {
    profileNumber: "3",
    pin: "1234",
    loginHelp: false,
    internalSecret: "discard",
  }), {
    profileNumber: "3",
    pin: "1234",
    loginHelp: false,
  });
  assert.deepEqual(normalizeFulfillment("spotify", {
    username: "User123",
    region: "europe",
    outcome: "family_joined",
    emailConfirmation: true,
    internalSecret: "discard",
  }, { plan: "member" }), {
    username: "User123",
    region: "europe",
    outcome: "family_joined",
    emailConfirmation: true,
  });
});

test("English orders receive an English generated message", () => {
  const order = {
    status: "completed",
    locale: "en",
    netflixDeliveryMode: "password",
    completedAt: "2026-07-27T10:00:00.000Z",
    items: [{
      service: "netflix",
      label: "Netflix · Dedicated profile",
      cycle: "1 year",
      plan: "seat",
      fulfillment: { profileNumber: "2", pin: "", loginHelp: true },
    }],
  };
  const message = buildDeliveryMessage(order, order.items, true);
  assert.match(message, /Netflix is active\. The login/);
  assert.match(message, /Use profile number 2/);
  assert.match(message, /select “Get Help,” then enter the password/);
  assert.match(message, /Do not change the account subscription/);
  assert.match(message, /Valid until 2027-07-27/);
  assert.match(message, /login email and password are included with the order/i);
  assert.match(message, /third-party platform/);
});

test("Netflix delivery copy gives concise password sign-in steps", () => {
  const order = {
    status: "completed",
    locale: "zh",
    netflixDeliveryMode: "password",
    completedAt: "2026-07-27T10:00:00.000Z",
    items: [{
      service: "netflix",
      label: "Netflix · 单独车位",
      cycle: "1年",
      plan: "seat",
      fulfillment: { profileNumber: "3", pin: "", loginHelp: true },
    }],
  };
  const message = buildDeliveryMessage(order);
  assert.match(message, /请使用数字 3 号用户档案/);
  assert.match(message, /输入邮箱，再点击“获取帮助 \/ Get Help”，然后输入订单中的密码/);
  assert.match(message, /不要修改账号订阅、密码或其他用户档案/);
  assert.doesNotMatch(message, /不要修改账号资料/);
});

test("Netflix self-service delivery copy follows the order switch without exposing internal details", () => {
  const order = {
    status: "completed",
    locale: "zh",
    netflixDeliveryMode: "self_service",
    completedAt: "2026-07-27T10:00:00.000Z",
    items: [{
      service: "netflix",
      label: "Netflix · 单独车位",
      cycle: "1年",
      plan: "seat",
      fulfillment: { profileNumber: "3", pin: "", loginHelp: true },
    }],
  };
  const message = buildDeliveryMessage(order);
  assert.match(message, /Netflix 登录邮箱已随订单交付/);
  assert.match(message, /Netflix 官方登录页输入订单中的邮箱并继续/);
  assert.match(message, /https:\/\/www\.liumeiti\.vip\/netflix-code/);
  assert.match(message, /登录码或打开 Netflix 官方确认链接/);
  assert.doesNotMatch(message, /然后输入订单中的密码/);
  assert.doesNotMatch(message, /账号与密码已随订单交付/);
  assert.doesNotMatch(message, /转发|解析|收件规则|codes\.liumeiti\.vip|后台/);
});

test("legacy Netflix orders without a delivery mode keep the original password guidance in English", () => {
  const order = {
    status: "completed",
    locale: "en",
    completedAt: "2026-07-27T10:00:00.000Z",
    items: [{
      service: "netflix",
      label: "Netflix · Dedicated profile",
      cycle: "1 year",
      plan: "seat",
      fulfillment: { profileNumber: "2", pin: "", loginHelp: true },
    }],
  };
  const message = buildDeliveryMessage(order);
  assert.match(message, /login email and password are included/);
  assert.match(message, /then enter the password shown in the order/);
  assert.doesNotMatch(message, /https:\/\/www\.liumeiti\.vip\/netflix-code/);
});

test("full-account delivery copy does not apply shared-profile restrictions", () => {
  const order = {
    status: "completed",
    locale: "zh",
    completedAt: "2026-07-27T10:00:00.000Z",
    items: [{
      service: "disney",
      label: "Disney+ · 整号购买",
      cycle: "1年",
      plan: "full",
      fulfillment: { profileNumber: "", pin: "", loginHelp: true },
    }],
  };
  const message = buildDeliveryMessage(order);
  assert.match(message, /本订单为整号规格/);
  assert.doesNotMatch(message, /请仅使用分配的用户档案/);
});
