import assert from "node:assert/strict";
import test from "node:test";
import { beginLatestRequest, invalidateLatestRequest, settleLatestRequest } from "../app/lib/latest-request.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("an older failure arriving after a newer success cannot overwrite UI or clear its busy state", async () => {
  const ref = { current: 0 };
  const older = deferred();
  const newer = deferred();
  const events = [];
  const oldId = beginLatestRequest(ref);
  const oldRun = settleLatestRequest({
    ref,
    requestId: oldId,
    operation: older.promise,
    onSuccess: (value) => events.push(["old-success", value]),
    onError: (error) => events.push(["old-error", error.message]),
    onFinally: () => events.push(["old-finally"]),
  });
  const newId = beginLatestRequest(ref);
  const newRun = settleLatestRequest({
    ref,
    requestId: newId,
    operation: newer.promise,
    onSuccess: (value) => events.push(["new-success", value]),
    onError: (error) => events.push(["new-error", error.message]),
    onFinally: () => events.push(["new-finally"]),
  });

  newer.resolve("signed-in");
  assert.equal((await newRun).committed, true);
  older.reject(new Error("stale 401"));
  assert.equal((await oldRun).stale, true);
  assert.deepEqual(events, [["new-success", "signed-in"], ["new-finally"]]);
});

test("an older success arriving after a newer failure cannot restore the wrong filter result", async () => {
  const ref = { current: 0 };
  const older = deferred();
  const newer = deferred();
  const events = [];
  const oldId = beginLatestRequest(ref);
  const oldRun = settleLatestRequest({
    ref,
    requestId: oldId,
    operation: older.promise,
    onSuccess: (value) => events.push(["old-success", value]),
    onFinally: () => events.push(["old-finally"]),
  });
  const newId = beginLatestRequest(ref);
  const newRun = settleLatestRequest({
    ref,
    requestId: newId,
    operation: newer.promise,
    onError: (error) => events.push(["new-error", error.message]),
    onFinally: () => events.push(["new-finally"]),
  });

  newer.reject(new Error("503"));
  assert.equal((await newRun).committed, true);
  older.resolve("old-filter-data");
  assert.equal((await oldRun).stale, true);
  assert.deepEqual(events, [["new-error", "503"], ["new-finally"]]);
});

test("invalidating a request on logout or filter cleanup suppresses its late success and finalizer", async () => {
  const ref = { current: 0 };
  const pending = deferred();
  const events = [];
  const requestId = beginLatestRequest(ref);
  const run = settleLatestRequest({
    ref,
    requestId,
    operation: pending.promise,
    onSuccess: () => events.push("success"),
    onError: () => events.push("error"),
    onFinally: () => events.push("finally"),
  });

  invalidateLatestRequest(ref);
  pending.resolve("late");
  assert.equal((await run).stale, true);
  assert.deepEqual(events, []);
});
