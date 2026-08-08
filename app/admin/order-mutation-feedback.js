export function isSafeOrderMutationRetry(input) {
  const data = typeof input === "object" && input ? input : { error: input };
  return data.error === "stale_revision" && data.mutationApplied === false;
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
    order_update_busy: "该订单正在处理中，请保持当前内容，稍后重试原操作",
    idempotency_conflict: "本次操作与尚未确认的原请求不一致，请先核对订单状态，再重试原操作",
    batch_operation_in_progress: "相同的批量操作仍在处理中，请稍后查看最新订单列表",
    // 删除前必须先结清的三类副作用，逐条说明该先做什么
    order_financial_effects_open: "该订单使用了余额或优惠券且尚未退款，请先完成退款再删除",
    order_commission_effect_open: "该订单的推荐佣金已结算，请先处理佣金记录再删除",
    order_stock_effect_open: "该订单仍占用库存，请先将订单标记为无效以释放库存，再删除",
    order_transition_pending: "该订单有未完成的状态变更，请等待其完成或刷新后重试",
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
