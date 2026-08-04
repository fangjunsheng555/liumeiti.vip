"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateMarketingCampaignDates } from "./marketing-campaign-form.js";
import { clientFetch as fetch } from "../lib/client-fetch";
import { beginLatestRequest, invalidateLatestRequest, isLatestRequest } from "../lib/latest-request";

const card = { border: "1px solid #dce5e3", borderRadius: 14, background: "#fff", padding: 12 };
const input = { width: "100%", boxSizing: "border-box", border: "1px solid #ccd9d6", borderRadius: 8, padding: "7px 10px", background: "#fff", color: "#183e3a" };

const CAMPAIGN_STATUS_LABELS = {
  draft: "草稿", scheduled: "已排期", sending: "发送中", paused: "已暂停",
  completed: "已完成", cancelled: "已取消", failed: "失败",
};

function formatCampaignTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

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
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError] = useState("");
  const [selectedStats, setSelectedStats] = useState(null);
  const [state, setState] = useState({ busy: "", message: "", error: "" });
  const campaignsRequestRef = useRef(0);
  const statsRequestRef = useRef(0);
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
    const requestId = beginLatestRequest(campaignsRequestRef);
    setCampaignsLoading(true);
    setCampaignsError("");
    try {
      const response = await fetch("/api/admin/mail/campaigns?limit=30&includeAttribution=1", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "活动列表加载失败");
      if (!isLatestRequest(campaignsRequestRef, requestId)) return;
      setCampaigns(data.campaigns || []);
    } catch (error) {
      if (isLatestRequest(campaignsRequestRef, requestId)) setCampaignsError(error.message || "活动列表加载失败");
    } finally {
      if (isLatestRequest(campaignsRequestRef, requestId)) setCampaignsLoading(false);
    }
  }, []);
  useEffect(() => {
    loadCampaigns().catch(() => {});
    return () => {
      invalidateLatestRequest(campaignsRequestRef);
      invalidateLatestRequest(statsRequestRef);
    };
  }, [loadCampaigns]);

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
    const requestId = beginLatestRequest(statsRequestRef);
    setState({ busy: `stats:${campaign.id}`, message: "", error: "" });
    try {
      const response = await fetch(`/api/admin/mail/campaigns/${encodeURIComponent(campaign.id)}/stats`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "活动统计加载失败");
      if (!isLatestRequest(statsRequestRef, requestId)) return;
      setSelectedStats(data);
      setState({ busy: "", message: "统计已刷新", error: "" });
    } catch (error) {
      if (isLatestRequest(statsRequestRef, requestId)) {
        setState({ busy: "", message: "", error: error.message || "活动统计加载失败" });
      }
    }
  }

  function closeStats() {
    invalidateLatestRequest(statsRequestRef);
    setSelectedStats(null);
    setState((current) => String(current.busy || "").startsWith("stats:")
      ? { busy: "", message: "", error: "" }
      : current);
  }

  return <section className="marketing-campaign-panel">
    <div className="marketing-campaign-card marketing-campaign-basics" style={card}>
      <h2 style={{ margin: "0 0 6px", color: "#173f3a" }}>营销活动</h2>
      <p className="marketing-campaign-description">服务端分群、发送前抑制检查、RFC 8058 退订和订单收入归因使用同一活动 ID。</p>
      <div className="marketing-campaign-basics-grid">
        <label>活动 ID<input style={input} value={form.campaignId} onChange={set("campaignId")} /></label>
        <label>活动名称<input style={input} value={form.name} onChange={set("name")} placeholder="八月会员优惠" /></label>
        <label>计划发送<input style={input} type="datetime-local" value={form.scheduledAt} onChange={set("scheduledAt")} /></label>
        <label>最多收件人<input style={input} type="number" min="1" max="500" value={form.maxRecipients} onChange={set("maxRecipients")} /></label>
      </div>
      <p role="note" className="marketing-campaign-schedule-note">
        Hobby 调度说明：活动会在计划时间后的下一次小时巡检发送，最多约 1 小时；“计划发送”不是精确到分钟的承诺。
      </p>
      <label className="marketing-campaign-subject">邮件主题<input style={input} value={form.subject} onChange={set("subject")} /></label>
    </div>
    <div className="marketing-campaign-card marketing-campaign-editor" style={card}>
      <div className="marketing-campaign-offer"><h3>优惠内容（v7）</h3><div className="marketing-campaign-field-grid">{[["badge","角标"],["headline","主标题"],["currentPrice","优惠价文案"],["originalPrice","原价文案"],["savingText","节省文案"],["couponCode","优惠码"],["endsAt","截止时间"],["ctaPath","按钮路径"]].map(([key,label]) => <label key={key} className={key === "headline" ? "wide" : ""}>{label}<input style={input} type={key === "endsAt" ? "datetime-local" : "text"} value={form[key]} onChange={set(key)} /></label>)}</div></div>
      <div className="marketing-campaign-segment"><h3>服务端分群</h3><div className="marketing-campaign-field-grid">
        <label className="wide">服务 key（逗号分隔）<input style={input} value={form.serviceKeys} onChange={set("serviceKeys")} placeholder="spotify,ai,rocket" /></label>
        <label>最近购买（天内）<input style={input} type="number" value={form.lastPurchaseWithinDays} onChange={set("lastPurchaseWithinDays")} /></label>
        <label>最低累计消费<input style={input} type="number" value={form.minSpend} onChange={set("minSpend")} /></label>
        <label>到期（天内）<input style={input} type="number" value={form.expiryWithinDays} onChange={set("expiryWithinDays")} /></label>
        <div className="marketing-campaign-locales">{["zh","en"].map((locale) => <label key={locale}><input type="checkbox" checked={form.locales.includes(locale)} onChange={(event) => setForm((current) => ({ ...current, locales: event.target.checked ? [...current.locales, locale] : current.locales.filter((item) => item !== locale) }))} /> {locale === "zh" ? "中文" : "English"}</label>)}</div>
        {audience ? <div className="marketing-campaign-audience wide">匹配 {audience.snapshot.matchedCount} · 可发送 {audience.snapshot.eligibleCount} · 已抑制 {audience.snapshot.suppressedCount} · 本次选择 {audience.snapshot.selectedCount}</div> : null}
      </div>
      </div>
    </div>
    <div className="marketing-campaign-actions">
      <button type="button" onClick={previewAudience} disabled={Boolean(state.busy)} style={{ ...input, width: "auto", cursor: "pointer" }}>预览分群</button>
      <button type="button" onClick={previewMail} disabled={Boolean(state.busy)} style={{ ...input, width: "auto", cursor: "pointer" }}>安全预览邮件</button>
      <button type="button" onClick={schedule} disabled={Boolean(state.busy) || !dateValidation.ok} style={{ border: 0, borderRadius: 8, padding: "8px 14px", background: "#08786c", color: "white", fontWeight: 750, cursor: "pointer", opacity: state.busy || !dateValidation.ok ? 0.55 : 1 }}>确认并排期</button>
      {state.error || !dateValidation.ok ? <span role="alert" style={{ color: "#b42318", alignSelf: "center" }}>{state.error || dateValidation.error}</span> : state.message ? <span role="status" style={{ color: "#08786c", alignSelf: "center" }}>{state.message}</span> : null}
    </div>
    {preview ? <details className="marketing-campaign-card marketing-campaign-preview" style={card} open><summary>沙箱预览</summary><iframe title="营销邮件预览" sandbox="" srcDoc={preview} /></details> : null}
    <div className="marketing-campaign-card marketing-campaign-list" style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}><h3 style={{ margin: 0 }}>最近活动</h3><button type="button" onClick={loadCampaigns} disabled={Boolean(state.busy) || campaignsLoading} style={{ ...input, width: "auto", cursor: "pointer" }}>{campaignsLoading ? "加载中" : "刷新列表"}</button></div>
      {campaignsError ? <div role="alert" style={{ color: "#b42318", marginBottom: 10, fontSize: 13 }}>活动列表未更新：{campaignsError}。请点击“刷新列表”重试。</div> : null}
      <div className="marketing-campaign-table-scroll"><table><thead><tr>{["活动","状态","计划时间","入队","送达","点击","收入","转化率","点击率","操作"].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{campaignsLoading && campaigns.length === 0 ? <tr><td colSpan={10} className="marketing-campaign-empty">活动列表加载中…</td></tr> : campaignsError && campaigns.length === 0 ? <tr><td colSpan={10} className="marketing-campaign-empty error">活动列表加载失败，当前空白不代表没有活动</td></tr> : campaigns.length === 0 ? <tr><td colSpan={10} className="marketing-campaign-empty">暂无营销活动</td></tr> : campaigns.map((campaign) => <tr key={campaign.id}>
        <td className="marketing-campaign-name"><strong>{campaign.name || campaign.id}</strong><div>{campaign.id}</div></td>
        <td>{CAMPAIGN_STATUS_LABELS[campaign.status] || campaign.status || "-"}</td><td className="marketing-campaign-time">{formatCampaignTime(campaign.scheduledAt)}</td>
        <td>{campaign.counters?.queued || 0}</td><td>{campaign.counters?.delivered || 0}</td><td>{campaign.counters?.uniqueClicks || 0}</td>
        <td>¥{Number(campaign.attribution?.revenue || 0).toFixed(2)}</td><td>{campaign.attribution?.conversionRate || 0}%</td><td>{campaign.attribution?.clickThroughRate || 0}%</td>
        <td className="marketing-campaign-row-actions"><div>
          <button type="button" onClick={() => viewStats(campaign)} disabled={Boolean(state.busy) || campaignsLoading} style={{ ...input, width: "auto", padding: "6px 8px", cursor: "pointer" }}>详情</button>
          {["scheduled", "sending"].includes(campaign.status) ? <button type="button" onClick={() => manageCampaign(campaign, "pause")} disabled={Boolean(state.busy) || campaignsLoading} style={{ ...input, width: "auto", padding: "6px 8px", cursor: "pointer" }}>暂停</button> : null}
          {campaign.status === "paused" ? <button type="button" onClick={() => manageCampaign(campaign, "resume")} disabled={Boolean(state.busy) || campaignsLoading} style={{ ...input, width: "auto", padding: "6px 8px", cursor: "pointer" }}>恢复</button> : null}
          {!['completed', 'cancelled', 'failed'].includes(campaign.status) ? <button type="button" onClick={() => manageCampaign(campaign, "cancel")} disabled={Boolean(state.busy) || campaignsLoading} style={{ ...input, width: "auto", padding: "6px 8px", color: "#a33b31", cursor: "pointer" }}>取消</button> : null}
        </div></td>
      </tr>)}</tbody></table></div>
    </div>
    {selectedStats ? <div className="marketing-campaign-card marketing-campaign-stats" style={card}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12, alignItems: "center" }}><div style={{ minWidth: 0, flex: "1 1 220px" }}><h3 style={{ margin: 0, overflowWrap: "anywhere" }}>{selectedStats.campaign.name || selectedStats.campaign.id} · 活动统计</h3><p style={{ margin: "5px 0 0", color: "#748481", fontSize: 12 }}>归因模型：最近一次营销邮件点击，30 天</p></div><div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><button type="button" onClick={() => viewStats(selectedStats.campaign)} disabled={Boolean(state.busy)} style={{ ...input, width: "auto" }}>刷新统计</button><button type="button" onClick={closeStats} style={{ ...input, width: "auto" }}>关闭</button></div></div>
      <div className="marketing-campaign-stat-grid">{[
        ["入队", selectedStats.counters?.queued || 0], ["已提交", selectedStats.counters?.submitted || 0], ["已送达", selectedStats.counters?.delivered || 0], ["唯一点击", selectedStats.counters?.uniqueClicks || 0],
        ["投诉", selectedStats.counters?.complained || 0], ["退订", selectedStats.counters?.unsubscribed || 0], ["成交订单", selectedStats.attribution?.saleCount || 0], ["活动收入", `¥${Number(selectedStats.attribution?.revenue || 0).toFixed(2)}`],
        ["点击转化率", `${selectedStats.attribution?.conversionRate || 0}%`], ["邮件点击率", `${selectedStats.attribution?.clickThroughRate || 0}%`],
      ].map(([label, value]) => <div key={label}><div>{label}</div><strong>{value}</strong></div>)}</div>
      {selectedStats.attribution?.orderIds?.length ? <p style={{ marginBottom: 0, color: "#667875", fontSize: 12 }}>归因订单：{selectedStats.attribution.orderIds.join("、")}</p> : null}
    </div> : null}
  </section>;
}
