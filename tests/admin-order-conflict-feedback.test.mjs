import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  batchOrderMutationFeedback,
  isSafeOrderMutationRetry,
  orderMutationErrorMessage,
} from "../app/admin/order-mutation-feedback.js";

test("single-order concurrency failures have explicit Chinese recovery guidance", () => {
  assert.equal(isSafeOrderMutationRetry({ error: "stale_revision", mutationApplied: false }), true);
  assert.equal(isSafeOrderMutationRetry({ error: "stale_revision", mutationApplied: true }), false);
  assert.equal(isSafeOrderMutationRetry("stale_revision"), false);
  assert.equal(isSafeOrderMutationRetry("order_update_busy"), false);
  assert.equal(isSafeOrderMutationRetry("idempotency_conflict"), false);
  assert.match(orderMutationErrorMessage({ error: "stale_revision", mutationApplied: false }), /已被他人修改/);
  assert.match(orderMutationErrorMessage({ error: "stale_revision", mutationApplied: false }), /重新加载最新数据/);
  assert.match(orderMutationErrorMessage({ error: "stale_revision", mutationApplied: true }), /主数据已写入/);
  assert.match(orderMutationErrorMessage({ error: "stale_revision", mutationApplied: true }), /不会重复发送/);
  assert.match(orderMutationErrorMessage("order_update_busy"), /保持当前内容/);
  assert.match(orderMutationErrorMessage("order_update_busy"), /重试原操作/);
});

test("partial batch conflicts identify each reason and retain failed selections", () => {
  const feedback = batchOrderMutationFeedback({
    successCount: 1,
    failedCount: 2,
    results: [
      { orderId: "LM-OK", ok: true },
      { orderId: "LM-STALE", ok: false, error: "stale_revision" },
      { orderId: "LM-BUSY", ok: false, error: "order_update_busy" },
    ],
  }, "invalid");
  assert.equal(feedback.type, "error");
  assert.deepEqual(feedback.failedOrderIds, ["LM-STALE", "LM-BUSY"]);
  assert.match(feedback.message, /1 个已被他人修改，请刷新后重试/);
  assert.match(feedback.message, /1 个正在被其他操作更新，请稍后重试/);
  assert.match(feedback.message, /失败订单已保留勾选/);
});

test("admin panel retires only safe pre-commit conflicts and reloads latest order", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  assert.match(source, /if \(!isSafeOrderMutationRetry\(data\)\)/);
  assert.match(source, /completeAdminMutation\(pending\.storageKey, pending\.operation\);[\s\S]*await openOrder\(\{ orderId \}\)/);
  assert.match(source, /setSelectedIds\(new Set\(feedback\.failedOrderIds\)\)/);
  assert.match(source, /handleOrderMutationConflict\(pending, res, data, "保存失败"\)/);
  assert.match(source, /data\?\.mutationApplied !== true/);
  assert.match(source, /replayAppliedOrderMutationOnce\(pending, res, data\)/);
  assert.match(source, /resumeExisting: true/);
  assert.match(source, /record\.payload/);
});
