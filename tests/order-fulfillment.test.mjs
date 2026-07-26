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
  assert.match(message, /Use profile 2/);
  assert.match(message, /Valid until 2027-07-27/);
  assert.match(message, /third-party platform/);
});
