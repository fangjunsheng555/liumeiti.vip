import test from "node:test";
import assert from "node:assert/strict";
import {
  compactNetflixMailEvents,
  filterNetflixAccessRecords,
  filterNetflixMailEvents,
} from "../app/api/admin/netflix-code/_records.js";

test("compacts forwarded siblings and keeps every underlying event id", () => {
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
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accepted, true);
  assert.equal(rows[0].result, "0707");
  assert.deepEqual(new Set(rows[0].eventIds), new Set(["NMREJECTED", "NMACCEPTED"]));
  assert.deepEqual(rows[0].accountEmails, ["juandavidsandoval1@outlook.es"]);
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
