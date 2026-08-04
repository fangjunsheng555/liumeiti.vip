"use client";

import { useState } from "react";
import { clientFetch as fetch, isClientRequestTimeout } from "../../lib/client-fetch";

function suppressionNotice(suppression, L) {
  const scope = String(suppression?.scope || "none");
  if (scope === "all") {
    return L("该邮箱因硬退信、投诉或邮件服务商拦截处于全面停发状态。请确认邮箱可正常收信后联系客服解除。", "All delivery is blocked after a hard bounce, complaint, or provider suppression. Confirm the address works, then contact support.");
  }
  if (scope === "optional") {
    return L("该邮箱因投诉或投递反馈暂停营销、续费和服务通知；订单必要通知仍按下方偏好处理。", "Marketing, renewal and service mail is paused after complaint or delivery feedback; order updates still follow your preference below.");
  }
  if (scope === "marketing" && suppression?.reason !== "marketing_unsubscribed") {
    return L("该邮箱当前暂停营销邮件。偏好仍可保存，解除投递限制前不会发送营销资讯。", "Marketing delivery is currently paused. Preferences are saved, but offers remain blocked until the restriction is cleared.");
  }
  return "";
}

export default function PreferenceForm({ token, initialPreferences, initialSuppression, maskedEmail, locale = "zh" }) {
  const L = (zh, en) => locale === "en" ? en : zh;
  const rows = [
    ["renewal", L("续费提醒", "Renewal reminders"), L("服务即将到期时发送提醒。", "Receive a reminder when a service is about to expire.")],
    ["serviceNotices", L("服务通知", "Service notices"), L("维护、故障和恢复等非安全通知。", "Maintenance, incidents and recovery notices that are not security-critical.")],
    ["orderUpdates", L("订单进度", "Order updates"), L("订单处理中、交付和售后状态变化。", "Processing, delivery and after-sales status changes.")],
  ];
  const [preferences, setPreferences] = useState({
    marketing: ["granted", "denied"].includes(initialPreferences?.marketing) ? initialPreferences.marketing : "unknown",
    renewal: initialPreferences?.renewal !== false,
    serviceNotices: initialPreferences?.serviceNotices !== false,
    orderUpdates: initialPreferences?.orderUpdates !== false,
  });
  const [suppression, setSuppression] = useState(initialSuppression || { scope: "none" });
  const [state, setState] = useState({ saving: false, error: "", saved: false });
  const deliveryNotice = suppressionNotice(suppression, L);

  async function save(event) {
    event.preventDefault();
    setState({ saving: true, error: "", saved: false });
    try {
      const response = await fetch("/api/email/preferences", {
        method: "PATCH",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          preferences: {
            ...(["granted", "denied"].includes(preferences.marketing) ? { marketing: preferences.marketing } : {}),
            renewal: preferences.renewal,
            serviceNotices: preferences.serviceNotices,
            orderUpdates: preferences.orderUpdates,
          },
        }),
      });
      let data = null;
      try { data = await response.json(); } catch {}
      if (!data || typeof data !== "object") {
        throw new Error(L("邮件偏好服务响应异常，请稍后重试。", "The email preference service returned an invalid response. Please try again."));
      }
      if (!response.ok || !data.ok) {
        throw new Error(response.status >= 500
          ? L("邮件偏好服务暂时不可用，请稍后重试。", "The email preference service is temporarily unavailable. Please try again.")
          : L("保存失败，请确认链接有效后重试。", "Could not save. Check that the link is valid and try again."));
      }
      if (data.preferences) setPreferences((current) => ({ ...current, ...data.preferences }));
      if (data.suppression) setSuppression(data.suppression);
      setState({ saving: false, error: "", saved: true });
    } catch (error) {
      setState({
        saving: false,
        error: isClientRequestTimeout(error)
          ? L("请求超时，请检查网络后重试。", "The request timed out. Check your connection and try again.")
          : (error?.name === "TypeError"
            ? L("网络连接失败，请检查网络后重试。", "The network request failed. Check your connection and try again.")
            : (error?.message || L("保存失败，请稍后重试。", "Could not save. Please try again."))),
        saved: false,
      });
    }
  }

  return <form onSubmit={save} style={{ marginTop: 24 }}>
    <div style={{ color: "#64748b", fontSize: 14, marginBottom: 18 }}>{L("当前邮箱：", "Email: ")}{maskedEmail}</div>
    {deliveryNotice ? <div role="status" style={{ marginBottom: 16, border: "1px solid #f1d39b", borderRadius: 12, background: "#fff8e8", color: "#7a4b00", padding: "12px 14px", fontSize: 13, lineHeight: 1.65 }}>{deliveryNotice}</div> : null}
    <div style={{ border: "1px solid #dbe4e2", borderRadius: 16, overflow: "hidden" }}>
      <label style={{ display: "block", padding: "17px 18px" }}><strong style={{ display: "block", color: "#123c38", fontSize: 15 }}>{L("优惠与新品", "Offers and new services")}</strong><span style={{ display: "block", color: "#71807e", fontSize: 13, margin: "4px 0 10px", lineHeight: 1.5 }}>{L("活动、折扣及新品推荐，可随时退订。", "Promotions, discounts and new-service recommendations. Unsubscribe at any time.")}</span><select value={preferences.marketing} onChange={(event) => setPreferences((current) => ({ ...current, marketing: event.target.value }))} style={{ width: "100%", border: "1px solid #ccd9d6", borderRadius: 9, padding: "9px 10px", background: "white" }}><option value="unknown">{L("尚未明确选择（保持当前状态）", "No explicit choice (keep current status)")}</option><option value="granted">{L("接收营销邮件", "Receive marketing email")}</option><option value="denied">{L("退订营销邮件", "Unsubscribe from marketing")}</option></select></label>
      {rows.map(([key, title, detail]) => <label key={key} style={{ display: "flex", gap: 16, alignItems: "center", padding: "17px 18px", borderTop: "1px solid #e8efed", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={preferences[key]}
          onChange={(event) => setPreferences((current) => ({ ...current, [key]: event.target.checked }))}
          style={{ width: 20, height: 20, accentColor: "#08786c", flex: "0 0 auto" }}
        />
        <span><strong style={{ display: "block", color: "#123c38", fontSize: 15 }}>{title}</strong><span style={{ display: "block", color: "#71807e", fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{detail}</span></span>
      </label>)}
    </div>
    <p style={{ color: "#7c8b89", fontSize: 12, lineHeight: 1.65, margin: "16px 2px" }}>{L("即使关闭可选通知，我们仍可能发送验证码、密码变更、付款凭证等必要的账户安全与交易邮件。", "Even when optional notices are off, we may still send verification, password-change, payment-receipt and other essential account-security or transaction emails.")}</p>
    <button disabled={state.saving} type="submit" style={{ width: "100%", border: 0, borderRadius: 12, padding: "13px 18px", background: state.saving ? "#91aaa6" : "#08786c", color: "white", fontSize: 15, fontWeight: 750, cursor: state.saving ? "wait" : "pointer" }}>{state.saving ? L("正在保存…", "Saving…") : L("保存邮件偏好", "Save email preferences")}</button>
    {state.saved ? <p role="status" style={{ color: "#08786c", textAlign: "center", fontSize: 14 }}>{L("已保存，设置立即生效。", "Saved. Your settings take effect immediately.")}</p> : null}
    {state.error ? <p role="alert" style={{ color: "#b42318", textAlign: "center", fontSize: 14 }}>{L("保存失败：", "Could not save: ")}{state.error}</p> : null}
  </form>;
}
