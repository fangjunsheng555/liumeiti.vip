import test from "node:test";
import assert from "node:assert/strict";
import {
  compactNetflixMailEvents,
  filterNetflixAccessRecords,
  filterNetflixMailEvents,
  netflixMailSearchValues,
} from "../app/api/admin/netflix-code/_records.js";
import { isNetflixOrderOwner, netflixOrderIdentity } from "../app/api/netflix-code/_ownership.js";

test("user-level Netflix controls follow the purchasing account, not the delivery email", () => {
  assert.deepEqual(netflixOrderIdentity({
    userEmail: "Owner-A@Example.com",
    email: "Receipt-B@Example.com",
  }), {
    ownerEmail: "owner-a@example.com",
    deliveryEmail: "receipt-b@example.com",
    linkedUserEmail: "owner-a@example.com",
  });
  assert.equal(netflixOrderIdentity({ email: "guest@example.com" }).ownerEmail, "guest@example.com");
  const splitIdentityOrder = { userEmail: "owner-a@example.com", email: "receipt-b@example.com" };
  assert.equal(isNetflixOrderOwner(splitIdentityOrder, "owner-a@example.com"), true);
  assert.equal(isNetflixOrderOwner(splitIdentityOrder, "receipt-b@example.com"), false);
});

test("keeps messages with different codes as independent audit rows", () => {
  const rows = compactNetflixMailEvents([
    {
      eventId: "NMREJECTED",
      accountKey: "matched:account-hash",
      accepted: false,
      receivedAt: "2026-08-01T05:20:01.000Z",
      accountEmails: ["juandavidsandoval1@outlook.es"],
      accountHints: ["ju******@outlook.es"],
      searchHashes: ["account-hash"],
      searchValues: ["LMMS9CRJODAFEF36D4", "buyer@example.com"],
      orders: [],
    },
    {
      eventId: "NMACCEPTED",
      accountKey: "matched:account-hash",
      accepted: true,
      kind: "code",
      result: "0707",
      receivedAt: "2026-08-01T05:20:03.000Z",
      accountEmails: ["juandavidsandoval1@outlook.es"],
      accountHints: ["ju******@outlook.es"],
      searchHashes: ["account-hash"],
      searchValues: ["LMMS9CRJODAFEF36D4", "buyer@example.com"],
      orders: [],
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].accepted, false);
  assert.equal(rows[1].accepted, true);
  assert.equal(rows[1].result, "0707");
  assert.deepEqual(rows[0].eventIds, ["NMREJECTED"]);
  assert.deepEqual(rows[1].eventIds, ["NMACCEPTED"]);
  assert.deepEqual(rows[1].accountEmails, ["juandavidsandoval1@outlook.es"]);
});

test("mail search matches contact email, order number and exact account hash", () => {
  const rows = [{
    eventId: "NMEVENT",
    searchValues: ["LMMS9CRJODAFEF36D4", "buyer@example.com"],
    searchHashes: ["netflix-account-hash"],
    accountEmails: ["full.netflix@outlook.es"],
    accountHints: ["ju******@outlook.es"],
  }];
  assert.equal(filterNetflixMailEvents(rows, "buyer@example.com").length, 1);
  assert.equal(filterNetflixMailEvents(rows, "9crjod").length, 1);
  assert.equal(filterNetflixMailEvents(rows, "full.netflix@outlook.es", "netflix-account-hash").length, 1);
  assert.equal(filterNetflixMailEvents(rows, "missing@example.com", "missing-hash").length, 0);
});

test("mail search keeps historical access-linked orders and purchasing accounts searchable", () => {
  const searchValues = netflixMailSearchValues([{
    orderId: "LM-HISTORICAL-ORDER",
    deliveryEmail: "receipt@example.com",
    ownerEmail: "buyer@example.com",
    linkedUserEmail: "buyer@example.com",
    accountEmail: "replacement.netflix@example.com",
  }]);
  const rows = [{ eventId: "NMOLD", searchValues, searchHashes: [], accountEmails: [], accountHints: [] }];
  assert.equal(filterNetflixMailEvents(rows, "historical-order").length, 1);
  assert.equal(filterNetflixMailEvents(rows, "buyer@example.com").length, 1);
  assert.equal(filterNetflixMailEvents(rows, "receipt@example.com").length, 1);
});

test("successful access search matches user email, Netflix account and order number", () => {
  const rows = [{
    id: "NA123",
    userEmail: "buyer@example.com",
    accountEmail: "netflix.member@outlook.jp",
    orderId: "LMMS9GZMS5193E10D6",
  }];
  assert.equal(filterNetflixAccessRecords(rows, "buyer@").length, 1);
  assert.equal(filterNetflixAccessRecords(rows, "member@outlook.jp").length, 1);
  assert.equal(filterNetflixAccessRecords(rows, "5193e10").length, 1);
  assert.equal(filterNetflixAccessRecords(rows, "not-found").length, 0);
});
