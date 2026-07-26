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
  assert.match(message, /欧洲区/);
  assert.match(message, /有效期至 2027-07-27/);
  assert.match(message, /账号与密码已随订单交付/);
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
});

test("English orders receive an English generated message", () => {
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
  const message = buildDeliveryMessage(order, order.items, true);
  assert.match(message, /Netflix is active\. The login/);
  assert.match(message, /Use profile 2/);
  assert.match(message, /Valid until 2027-07-27/);
  assert.match(message, /login email and password are included with the order/i);
  assert.match(message, /Use only the assigned profile/);
  assert.match(message, /third-party platform/);
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
