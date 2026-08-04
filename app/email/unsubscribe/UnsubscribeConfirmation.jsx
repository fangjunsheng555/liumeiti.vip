"use client";

import Link from "next/link";
import { useState } from "react";
import { clientFetch as fetch, isClientRequestTimeout } from "../../lib/client-fetch";

export default function UnsubscribeConfirmation({ token, locale = "zh", initiallyUnsubscribed = false }) {
  const L = (zh, en) => locale === "en" ? en : zh;
  const [state, setState] = useState({
    submitting: false,
    unsubscribed: initiallyUnsubscribed,
    error: "",
  });

  async function confirmUnsubscribe() {
    if (state.submitting || state.unsubscribed) return;
    setState({ submitting: true, unsubscribed: false, error: "" });
    try {
      const response = await fetch(`/api/email/unsubscribe?token=${encodeURIComponent(token)}`, {
        method: "POST",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      let data = null;
      try { data = await response.json(); } catch {}
      if (!data || typeof data !== "object") {
        throw new Error(L("退订服务响应异常，请稍后重试。", "The unsubscribe service returned an invalid response. Please try again."));
      }
      if (!response.ok || !data.ok) {
        throw new Error(response.status >= 500
          ? L("退订服务暂时不可用，请稍后重试。", "The unsubscribe service is temporarily unavailable. Please try again.")
          : L("退订失败，请确认链接有效后重试。", "Could not unsubscribe. Check that the link is valid and try again."));
      }
      setState({ submitting: false, unsubscribed: true, error: "" });
    } catch (error) {
      setState({
        submitting: false,
        unsubscribed: false,
        error: isClientRequestTimeout(error)
          ? L("请求超时，请检查网络后重试。", "The request timed out. Check your connection and try again.")
          : (error?.name === "TypeError"
            ? L("网络连接失败，请检查网络后重试。", "The network request failed. Check your connection and try again.")
            : (error?.message || L("退订失败，请稍后重试。", "Could not unsubscribe. Please try again."))),
      });
    }
  }

  return <div style={{ marginTop: 26 }}>
    {state.unsubscribed
      ? <div role="status" aria-live="polite" style={{ border: "1px solid #b8ddd4", borderRadius: 16, background: "#effaf6", padding: "18px 20px", color: "#075f55", fontSize: 14, lineHeight: 1.7 }}>
          <strong style={{ display: "block", fontSize: 17, marginBottom: 4 }}>{L("已退订营销邮件", "Marketing email unsubscribed")}</strong>
          {L("设置已立即生效。订单进度、验证码和账户安全邮件仍会正常发送。", "Your choice is effective immediately. Order, verification and account-security email will continue normally.")}
        </div>
      : <>
          <button
            type="button"
            onClick={confirmUnsubscribe}
            disabled={state.submitting}
            style={{ width: "100%", minHeight: 50, border: 0, borderRadius: 13, padding: "13px 18px", background: state.submitting ? "#91aaa6" : "#08786c", color: "white", fontSize: 16, fontWeight: 800, cursor: state.submitting ? "wait" : "pointer", boxShadow: "0 9px 22px rgba(8,120,108,.2)" }}
          >{state.submitting ? L("正在退订…", "Unsubscribing…") : L("确认退订营销邮件", "Confirm marketing unsubscribe")}</button>
          {state.error ? <p role="alert" aria-live="assertive" style={{ color: "#b42318", textAlign: "center", fontSize: 13, lineHeight: 1.6, margin: "12px 0 0" }}>{state.error}</p> : null}
        </>}
    <p style={{ margin: "18px 0 0", textAlign: "center", color: "#687b78", fontSize: 13, lineHeight: 1.6 }}>
      <Link href={`/email/preferences?token=${encodeURIComponent(token)}`} referrerPolicy="no-referrer" style={{ color: "#08786c", fontWeight: 700 }}>
        {L("管理其他邮件偏好", "Manage other email preferences")}
      </Link>
    </p>
  </div>;
}
