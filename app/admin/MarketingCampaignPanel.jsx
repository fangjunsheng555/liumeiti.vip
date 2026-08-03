"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { validateMarketingCampaignDates } from "./marketing-campaign-form.js";
import { clientFetch as fetch } from "../lib/client-fetch";

const card = { border: "1px solid #dce5e3", borderRadius: 16, background: "#fff", padding: 18 };
const input = { width: "100%", boxSizing: "border-box", border: "1px solid #ccd9d6", borderRadius: 9, padding: "9px 11px", background: "#fff", color: "#183e3a" };

function campaignId() {
  return `MKT${new Date().toISOString().slice(0, 10).replaceAll("-", "")}${Date.now().toString(36).toUpperCase()}`;
}

function localSchedule() {
  const date = new Date(Date.now() + 10 * 60 * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export default function MarketingCampaignPanel() {
  const [form, setForm] = useState({
    campaignId: campaignId(), name: "", subject: "会员服务限时优惠｜按你的使用场景轻松选择", scheduledAt: localSchedule(),
    locales: [], serviceKeys: "", lastPurchaseWithinDays: "", minSpend: "", expiryWithinDays: "", maxRecipients: 500,
    badge: "本期精选", headline: "常用数字服务，优惠与规格一次看清", currentPrice: "查看活动价格", originalPrice: "", savingText: "", couponCode: "", endsAt: "", ctaPath: "/shop",
  });
  const [audience, setAudience] = useState(null);
  const [preview, setPreview] = useState("");
  const [campaigns, setCampaigns] = useState([]);
  const [selectedStats, setSelectedStats] = useState(null);
  const [state, setState] = useState({ busy: "", message: "", error: "" });
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const segment = useMemo(() => ({
    sources: ["registered", "customer"],
    locales: form.locales,
    serviceKeys: form.serviceKeys.split(",").map((value) => value.trim()).filter(Boolean),
    lastPurchaseWithinDays: form.lastPurchaseWithinDays || null,
    minSpend: form.minSpend || null,
    expiryWithinDays: form.expiryWithinDays || null,
  }), [form]);
  const dateValidation = useMemo(
    () => validateMarketingCampaignDates({ scheduledAt: form.scheduledAt, endsAt: form.endsAt }),
    [form.scheduledAt, form.endsAt],
  );
  const offer = useMemo(() => ({ badge: form.badge, headline: form.headline, currentPrice: form.currentPrice, originalPrice: form.originalPrice, savingText: form.savingText, couponCode: form.couponCode, endsAt: dateValidation.endsAtIso, ctaPath: form.ctaPath, serviceKeys: segment.serviceKeys }), [form, segment.serviceKeys, dateValidation.endsAtIso]);

  const loadCampaigns = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/mail/campaigns?limit=30&includeAttribution=1", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "活动列表加载失败");
      setCampaigns(data.campaigns || []);
    } catch (error) {
      setState((current) => ({ ...current, busy: "", error: error.message || "活动列表加载失败" }));
    }
  }, []);
  useEffect(() => { loadCampaigns().catch(() => {}); }, [loadCampaigns]);

  async function request(kind, url, payload) {
    setState({ busy: kind, message: "", error: "" });
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "请求失败");
      setState({ busy: "", message: kind === "schedule" ? `活动已入队：${data.scheduledCount}，抑制：${data.suppressedCount || 0}` : "已更新", error: "" });
      return data;
    } catch (error) {
      setState({ busy: "", message: "", error: error.message || "请求失败" });
      return null;
    }
  }

  async function previewMail() {
    if (!dateValidation.ok && form.endsAt) {
      setState({ busy: "", message: "", error: dateValidation.error });
      return;
    }
    const data = await request("preview", "/api/admin/mail/preview", { template: "service_selection_edm_v7", subject: form.subject, offer });
    if (data) setPreview(data.html || "");
  }
  async function previewAudience() {
    const data = await request("audience", "/api/admin/mail/audience", { segment, limit: form.maxRecipients });
    if (data) setAudience(data.audience);
  }
  async function schedule() {
    if (!dateValidation.ok) {
      setState({ busy: "", message: "", error: dateValidation.error });
      return;
    }
    const data = await request("schedule", "/api/admin/mail/campaign", {
      campaignId: form.campaignId, name: form.name || form.subject, subject: form.subject,
      scheduledAt: dateValidation.scheduledIso, template: "service_selection_edm_v7", locale: form.locales.length === 1 ? form.locales[0] : "zh",
      segment, maxRecipients: Number(form.maxRecipients || 500), offer,
    });
    if (data) { setForm((current) => ({ ...current, campaignId: campaignId() })); await loadCampaigns(); }
  }

  async function manageCampaign(campaign, action) {
    const labels = { pause: "暂停", resume: "恢复", cancel: "取消" };
    if (!window.confirm(`确认${labels[action] || action}活动“${campaign.name || campaign.id}”？`)) return;
    setState({ busy: `manage:${campaign.id}`, message: "", error: "" });
    try {
      const response = await fetch(`/api/admin/mail/campaigns/${encodeURIComponent(campaign.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "活动状态更新失败");
      setState({ busy: "", message: `活动已${labels[action] || "更新"}`, error: "" });
      await loadCampaigns();
      if (selectedStats?.campaign?.id === campaign.id) await viewStats(campaign);
    } catch (error) {
      setState({ busy: "", message: "", error: error.message || "活动状态更新失败" });
    }
  }

  async function viewStats(campaign) {
    setState({ busy: `stats:${campaign.id}`, message: "", error: "" });
    try {
      const response = await fetch(`/api/admin/mail/campaigns/${encodeURIComponent(campaign.id)}/stats`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "活动统计加载失败");
      setSelectedStats(data);
      setState({ busy: "", message: "统计已刷新", error: "" });
    } catch (error) {
      setState({ busy: "", message: "", error: error.message || "活动统计加载失败" });
    }
  }

  return <section style={{ display: "grid", gap: 16 }}>
    <div style={card}>
      <h2 style={{ margin: "0 0 6px", color: "#173f3a" }}>营销活动</h2>
      <p style={{ margin: "0 0 18px", color: "#6d7f7c", fontSize: 13 }}>服务端分群、发送前抑制检查、RFC 8058 退订和订单收入归因使用同一活动 ID。</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 12 }}>
        <label>活动 ID<input style={input} value={form.campaignId} onChange={set("campaignId")} /></label>
        <label>活动名称<input style={input} value={form.name} onChange={set("name")} placeholder="八月会员优惠" /></label>
        <label>计划发送<input style={input} type="datetime-local" value={form.scheduledAt} onChange={set("scheduledAt")} /></label>
        <label>最多收件人<input style={input} type="number" min="1" max="500" value={form.maxRecipients} onChange={set("maxRecipients")} /></label>
      </div>
      <p role="note" style={{ margin: "10px 0 0", padding: "9px 11px", border: "1px solid #dbe8e4", borderRadius: 9, background: "#f3f8f6", color: "#536c67", fontSize: 12, lineHeight: 1.6 }}>
        Hobby 调度说明：活动会在计划时间后的下一次小时巡检发送，最多约 1 小时；“计划发送”不是精确到分钟的承诺。
      </p>
      <label style={{ display: "block", marginTop: 12 }}>邮件主题<input style={input} value={form.subject} onChange={set("subject")} /></label>
    </div>
    <div style={{ ...card, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 18 }}>
      <div><h3 style={{ marginTop: 0 }}>优惠内容（v7）</h3>{[["badge","角标"],["headline","主标题"],["currentPrice","优惠价文案"],["originalPrice","原价文案"],["savingText","节省文案"],["couponCode","优惠码"],["endsAt","截止时间"],["ctaPath","按钮路径"]].map(([key,label]) => <label key={key} style={{ display: "block", margin: "9px 0", fontSize: 13 }}>{label}<input style={input} type={key === "endsAt" ? "datetime-local" : "text"} value={form[key]} onChange={set(key)} /></label>)}</div>
      <div><h3 style={{ marginTop: 0 }}>服务端分群</h3>
        <label style={{ display: "block", margin: "9px 0", fontSize: 13 }}>服务 key（逗号分隔）<input style={input} value={form.serviceKeys} onChange={set("serviceKeys")} placeholder="spotify,ai,rocket" /></label>
        <label style={{ display: "block", margin: "9px 0", fontSize: 13 }}>最近购买（天内）<input style={input} type="number" value={form.lastPurchaseWithinDays} onChange={set("lastPurchaseWithinDays")} /></label>
        <label style={{ display: "block", margin: "9px 0", fontSize: 13 }}>最低累计消费<input style={input} type="number" value={form.minSpend} onChange={set("minSpend")} /></label>
        <label style={{ display: "block", margin: "9px 0", fontSize: 13 }}>到期（天内）<input style={input} type="number" value={form.expiryWithinDays} onChange={set("expiryWithinDays")} /></label>
        <div style={{ display: "flex", gap: 12, marginTop: 13 }}>{["zh","en"].map((locale) => <label key={locale}><input type="checkbox" checked={form.locales.includes(locale)} onChange={(event) => setForm((current) => ({ ...current, locales: event.target.checked ? [...current.locales, locale] : current.locales.filter((item) => item !== locale) }))} /> {locale === "zh" ? "中文" : "English"}</label>)}</div>
        {audience ? <div style={{ marginTop: 15, padding: 12, background: "#f2f8f6", borderRadius: 10, fontSize: 13 }}>匹配 {audience.snapshot.matchedCount} · 可发送 {audience.snapshot.eligibleCount} · 已抑制 {audience.snapshot.suppressedCount} · 本次选择 {audience.snapshot.selectedCount}</div> : null}
      </div>
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      <button type="button" onClick={previewAudience} disabled={Boolean(state.busy)} style={{ ...input, width: "auto", cursor: "pointer" }}>预览分群</button>
      <button type="button" onClick={previewMail} disabled={Boolean(state.busy)} style={{ ...input, width: "auto", cursor: "pointer" }}>安全预览邮件</button>
      <button type="button" onClick={schedule} disabled={Boolean(state.busy) || !dateValidation.ok} style={{ border: 0, borderRadius: 9, padding: "10px 16px", background: "#08786c", color: "white", fontWeight: 750, cursor: "pointer", opacity: state.busy || !dateValidation.ok ? 0.55 : 1 }}>确认并排期</button>
      {state.error || !dateValidation.ok ? <span role="alert" style={{ color: "#b42318", alignSelf: "center" }}>{state.error || dateValidation.error}</span> : state.message ? <span role="status" style={{ color: "#08786c", alignSelf: "center" }}>{state.message}</span> : null}
    </div>
    {preview ? <div style={card}><h3 style={{ marginTop: 0 }}>沙箱预览</h3><iframe title="营销邮件预览" sandbox="" srcDoc={preview} style={{ width: "100%", minHeight: 720, border: "1px solid #d9e3e0", borderRadius: 10, background: "white" }} /></div> : null}
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}><h3 style={{ margin: 0 }}>最近活动</h3><button type="button" onClick={loadCampaigns} disabled={state.busy} style={{ ...input, width: "auto", cursor: "pointer" }}>刷新列表</button></div>
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}><thead><tr>{["活动","状态","计划时间","入队","送达","点击","收入","转化率","点击率","操作"].map((label) => <th key={label} style={{ textAlign: "left", padding: 9, borderBottom: "1px solid #dfe7e5", whiteSpace: "nowrap" }}>{label}</th>)}</tr></thead><tbody>{campaigns.length === 0 ? <tr><td colSpan={10} style={{ padding: "22px 9px", color: "#82908e", textAlign: "center" }}>暂无营销活动</td></tr> : campaigns.map((campaign) => <tr key={campaign.id} style={{ borderBottom: "1px solid #edf2f1" }}>
        <td style={{ padding: 9, minWidth: 150 }}><strong>{campaign.name || campaign.id}</strong><div style={{ color: "#82908e", fontSize: 11, marginTop: 3 }}>{campaign.id}</div></td>
        <td style={{ padding: 9 }}>{campaign.status}</td><td style={{ padding: 9, whiteSpace: "nowrap" }}>{campaign.scheduledAt ? new Date(campaign.scheduledAt).toLocaleString() : "-"}</td>
        <td style={{ padding: 9 }}>{campaign.counters?.queued || 0}</td><td style={{ padding: 9 }}>{campaign.counters?.delivered || 0}</td><td style={{ padding: 9 }}>{campaign.counters?.uniqueClicks || 0}</td>
        <td style={{ padding: 9 }}>¥{Number(campaign.attribution?.revenue || 0).toFixed(2)}</td><td style={{ padding: 9 }}>{campaign.attribution?.conversionRate || 0}%</td><td style={{ padding: 9 }}>{campaign.attribution?.clickThroughRate || 0}%</td>
        <td style={{ padding: 9, minWidth: 220 }}><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <button type="button" onClick={() => viewStats(campaign)} disabled={Boolean(state.busy)} style={{ ...input, width: "auto", padding: "6px 8px", cursor: "pointer" }}>详情</button>
          {["scheduled", "sending"].includes(campaign.status) ? <button type="button" onClick={() => manageCampaign(campaign, "pause")} disabled={Boolean(state.busy)} style={{ ...input, width: "auto", padding: "6px 8px", cursor: "pointer" }}>暂停</button> : null}
          {campaign.status === "paused" ? <button type="button" onClick={() => manageCampaign(campaign, "resume")} disabled={Boolean(state.busy)} style={{ ...input, width: "auto", padding: "6px 8px", cursor: "pointer" }}>恢复</button> : null}
          {!['completed', 'cancelled', 'failed'].includes(campaign.status) ? <button type="button" onClick={() => manageCampaign(campaign, "cancel")} disabled={Boolean(state.busy)} style={{ ...input, width: "auto", padding: "6px 8px", color: "#a33b31", cursor: "pointer" }}>取消</button> : null}
        </div></td>
      </tr>)}</tbody></table></div>
    </div>
    {selectedStats ? <div style={card}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12, alignItems: "center" }}><div style={{ minWidth: 0, flex: "1 1 220px" }}><h3 style={{ margin: 0, overflowWrap: "anywhere" }}>{selectedStats.campaign.name || selectedStats.campaign.id} · 活动统计</h3><p style={{ margin: "5px 0 0", color: "#748481", fontSize: 12 }}>归因模型：最近一次营销邮件点击，30 天</p></div><div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><button type="button" onClick={() => viewStats(selectedStats.campaign)} disabled={Boolean(state.busy)} style={{ ...input, width: "auto" }}>刷新统计</button><button type="button" onClick={() => setSelectedStats(null)} style={{ ...input, width: "auto" }}>关闭</button></div></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(125px,1fr))", gap: 10, marginTop: 16 }}>{[
        ["入队", selectedStats.counters?.queued || 0], ["已提交", selectedStats.counters?.submitted || 0], ["已送达", selectedStats.counters?.delivered || 0], ["唯一点击", selectedStats.counters?.uniqueClicks || 0],
        ["投诉", selectedStats.counters?.complained || 0], ["退订", selectedStats.counters?.unsubscribed || 0], ["成交订单", selectedStats.attribution?.saleCount || 0], ["活动收入", `¥${Number(selectedStats.attribution?.revenue || 0).toFixed(2)}`],
        ["点击转化率", `${selectedStats.attribution?.conversionRate || 0}%`], ["邮件点击率", `${selectedStats.attribution?.clickThroughRate || 0}%`],
      ].map(([label, value]) => <div key={label} style={{ padding: 12, borderRadius: 10, background: "#f2f8f6" }}><div style={{ color: "#71817e", fontSize: 12 }}>{label}</div><strong style={{ display: "block", color: "#173f3a", fontSize: 19, marginTop: 5 }}>{value}</strong></div>)}</div>
      {selectedStats.attribution?.orderIds?.length ? <p style={{ marginBottom: 0, color: "#667875", fontSize: 12 }}>归因订单：{selectedStats.attribution.orderIds.join("、")}</p> : null}
    </div> : null}
  </section>;
}
