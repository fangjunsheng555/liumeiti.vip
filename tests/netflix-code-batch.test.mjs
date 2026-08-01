import test from "node:test";
import assert from "node:assert/strict";
import {
  recordDeleteBatches,
  selectedMailDeletionIds,
  toggleRecordSelection,
  toggleVisibleRecordSelection,
} from "../app/admin/netflix-code-batch.js";

test("record selection supports individual and current-list toggles", () => {
  assert.deepEqual(toggleRecordSelection([], "A"), ["A"]);
  assert.deepEqual(toggleRecordSelection(["A"], "A"), []);
  assert.deepEqual(toggleVisibleRecordSelection(["OLD"], ["A", "B"]), ["OLD", "A", "B"]);
  assert.deepEqual(toggleVisibleRecordSelection(["OLD", "A", "B"], ["A", "B"]), ["OLD"]);
});

test("selected compact mail rows delete every underlying delivery copy", () => {
  const events = [
    { eventId: "DISPLAY-A", eventIds: ["MAIL-A1", "MAIL-A2"] },
    { eventId: "DISPLAY-B", eventIds: ["MAIL-B"] },
  ];
  assert.deepEqual(selectedMailDeletionIds(events, ["DISPLAY-A"]), ["MAIL-A1", "MAIL-A2"]);
});

test("large batch deletion is split to the existing API limit", () => {
  const ids = Array.from({ length: 93 }, (_, index) => `ID-${index}`);
  const batches = recordDeleteBatches(ids);
  assert.deepEqual(batches.map((batch) => batch.length), [40, 40, 13]);
  assert.equal(new Set(batches.flat()).size, 93);
});
