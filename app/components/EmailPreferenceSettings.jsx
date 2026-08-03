"use client";

import { useEffect, useState } from "react";
import { clientFetch as fetch } from "../lib/client-fetch";

const empty = { marketing: "unknown", orderUpdates: true, renewal: true, serviceNotices: true };
const CARD = { border: "1px solid #dbe4ef", borderRadius: 16, background: "#fff", padding: "17px 18px", display: "grid", gap: 12 };
const ROW = { minHeight: 46, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "10px 12px", border: "1px solid #e2e8f0", borderRadius: 12, background: "#f8fafc", color: "#334155", fontSize: 12.5, fontWeight: 750 };
const BUTTON = { minHeight: 38, border: 0, borderRadius: 10, padding: "0 14px", background: "#0f766e", color: "#fff", fontSize: 12, fontWeight: 850, cursor: "pointer" };
const SELECT = { border: "1px solid #cbd5e1", borderRadius: 9, background: "#fff", color: "#334155", padding: "7px 9px", fontSize: 12 };

function suppressionMessage(suppression, L) {
  const scope = String(suppression?.scope || "none");
  if (scope === "all") return L(
    "该邮箱因硬退信、投诉或邮件服务商拦截处于全面停发状态，请确认邮箱有效后联系客服解除。",
    "All delivery is blocked after a hard bounce, complaint, or provider suppression. Confirm the address works, then contact support.",
  );
  if (scope === "optional") return L(
    "该邮箱因投诉或投递反馈暂停营销、续费和服务通知；订单通知仍按偏好处理。",
    "Marketing, renewal and service mail is paused after complaint or delivery feedback; order updates still follow your preference.",
  );
  if (scope === "marketing" && suppression?.reason !== "marketing_unsubscribed") return L(
    "该邮箱当前暂停营销邮件；偏好可以保存，但解除投递限制前不会发送营销资讯。",
    "Marketing delivery is currently paused. Preferences are saved, but offers remain blocked until the restriction is cleared.",
  );
  return "";
}

export default function EmailPreferenceSettings({ locale = "zh" }) {
  const L = (zh, en) => locale === "en" ? en : zh;
  const [preferences, setPreferences] = useState(empty);
  const [suppression, setSuppression] = useState({ scope: "none" });
  const [state, setState] = useState({ loading: true, saving: false, error: "", saved: false });
  const deliveryNotice = suppressionMessage(suppression, L);

  useEffect(() => {
    let active = true;
    fetch("/api/account/email-preferences", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "加载失败");
        if (active) {
          setPreferences({ ...empty, ...data.preferences });
          setSuppression(data.suppression || { scope: "none" });
          setState({ loading: false, saving: false, error: "", saved: false });
        }
      })
      .catch((error) => active && setState({ loading: false, saving: false, error: error.message || "加载失败", saved: false }));
    return () => { active = false; };
  }, []);

  async function save() {
    setState((current) => ({ ...current, saving: true, error: "", saved: false }));
    try {
      const response = await fetch("/api/account/email-preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: locale === "en" ? "en" : "zh", preferences: {
          ...(["granted", "denied"].includes(preferences.marketing) ? { marketing: preferences.marketing } : {}),
          orderUpdates: preferences.orderUpdates,
          renewal: preferences.renewal,
          serviceNotices: preferences.serviceNotices,
        } }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "保存失败");
      setPreferences((current) => ({ ...current, ...data.preferences }));
      setSuppression(data.suppression || { scope: "none" });
      setState({ loading: false, saving: false, error: "", saved: true });
    } catch (error) {
      setState({ loading: false, saving: false, error: error.message || "保存失败", saved: false });
    }
  }

  if (state.loading) return <section style={CARD}><strong>{L("邮件偏好", "Email preferences")}</strong><span style={{ color: "#64748b", fontSize: 12 }}>{L("正在加载…", "Loading…")}</span></section>;
  return <section style={CARD} aria-labelledby="email-preference-title">
    <header><strong id="email-preference-title" style={{ display: "block", color: "#0f172a", fontSize: 15, fontWeight: 900 }}>{L("邮件偏好", "Email preferences")}</strong><span style={{ display: "block", marginTop: 3, color: "#64748b", fontSize: 11, lineHeight: 1.55 }}>{L("营销、续费、服务和订单通知可分别设置；验证码与账户安全邮件始终保留。", "Choose marketing, renewal, service and order mail separately. Verification and account-security mail always remains enabled.")}</span></header>
    {deliveryNotice ? <p role="status" style={{ margin: 0, border: "1px solid #f1d39b", borderRadius: 10, background: "#fff8e8", color: "#7a4b00", padding: "10px 11px", fontSize: 11.5, lineHeight: 1.55 }}>{deliveryNotice}</p> : null}
    <label style={ROW}><span>{L("优惠与新品", "Offers and new services")}</span><select style={SELECT} value={preferences.marketing} onChange={(event) => setPreferences((current) => ({ ...current, marketing: event.target.value }))}><option value="unknown">{L("尚未明确选择", "Not explicitly chosen")}</option><option value="granted">{L("接收", "Receive")}</option><option value="denied">{L("退订", "Unsubscribe")}</option></select></label>
    {[["orderUpdates", L("订单进度", "Order updates")], ["renewal", L("续费提醒", "Renewal reminders")], ["serviceNotices", L("服务通知", "Service notices")]].map(([key, label]) => <label key={key} style={ROW}><span>{label}</span><input type="checkbox" checked={preferences[key] !== false} onChange={(event) => setPreferences((current) => ({ ...current, [key]: event.target.checked }))} style={{ width: 20, height: 20, accentColor: "#08786c" }} /></label>)}
    <button type="button" onClick={save} disabled={state.saving} style={{ ...BUTTON, opacity: state.saving ? .6 : 1 }}>{state.saving ? L("保存中…", "Saving…") : L("保存邮件偏好", "Save email preferences")}</button>
    {state.saved ? <p role="status" style={{ color: "#08786c", margin: 0, fontSize: 12 }}>{L("已保存并立即生效。", "Saved and effective immediately.")}</p> : null}
    {state.error ? <p role="alert" style={{ color: "#b42318", margin: 0, fontSize: 12 }}>{L("邮件偏好：", "Email preferences: ")}{state.error}</p> : null}
  </section>;
}
