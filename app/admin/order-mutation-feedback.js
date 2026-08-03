const SAFE_RETRY_CONFLICTS = new Set(["stale_revision", "order_update_busy"]);

export function isSafeOrderMutationRetry(input) {
  const data = typeof input === "object" && input ? input : { error: input };
  const error = String(data.error || "");
  if (!SAFE_RETRY_CONFLICTS.has(error)) return false;
  if (error === "order_update_busy") return true;
  return data.mutationApplied === false;
}

export function orderMutationErrorMessage(input, fallback = "订单操作失败") {
  const data = typeof input === "object" && input ? input : { error: input };
  const code = String(data.error || "");
  if (code === "stale_revision" && data.mutationApplied === true) {
    return "订单主数据已写入，但收尾记录遇到并发；请保持当前内容并再次点击原操作，系统会安全续跑且不会重复发送";
  }
  return {
    stale_revision: data.mutationApplied === false
      ? "该订单已被他人修改，已重新加载最新数据，请核对后重试"
      : "检测到订单版本冲突；请保持当前内容并再次点击原操作，完成后系统会刷新最新数据",
    order_update_busy: "该订单正在被其他操作更新，已刷新最新数据，请稍后重试",
    idempotency_conflict: "本次操作与尚未确认的原请求不一致，请先核对订单状态，再重试原操作",
    batch_operation_in_progress: "相同的批量操作仍在处理中，请稍后查看最新订单列表",
  }[code] || fallback;
}

export function batchOrderMutationFeedback(data, action) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const failed = results.filter((item) => !item?.ok);
  const verb = action === "delete" ? "删除" : "标记为无效";
  if (failed.length === 0) {
    return {
      type: "success",
      message: `已${verb} ${Number(data?.successCount || 0)} 个订单`,
      failedOrderIds: [],
    };
  }

  const counts = new Map();
  for (const item of failed) {
    const code = String(item?.error || "batch_operation_failed");
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const reasons = [...counts.entries()].map(([code, count]) => {
    const label = {
      stale_revision: "已被他人修改，请刷新后重试",
      order_update_busy: "正在被其他操作更新，请稍后重试",
      order_not_found: "未找到",
      order_not_archivable: "当前状态不可删除",
    }[code] || "操作失败";
    return `${count} 个${label}`;
  });
  return {
    type: "error",
    message: `已${verb} ${Number(data?.successCount || 0)} 个订单；${reasons.join("，")}。订单列表已刷新，失败订单已保留勾选`,
    failedOrderIds: failed.map((item) => String(item?.orderId || "")).filter(Boolean),
  };
}
