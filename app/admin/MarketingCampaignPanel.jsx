"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateMarketingCampaignDates } from "./marketing-campaign-form.js";
import { clientFetch as fetch } from "../lib/client-fetch";
import { beginLatestRequest, invalidateLatestRequest, isLatestRequest } from "../lib/latest-request";

const card = { border: "1px solid #dce5e3", borderRadius: 14, background: "#fff", padding: 12 };
const input = { width: "100%", boxSizing: "border-box", border: "1px solid #ccd9d6", borderRadius: 8, padding: "7px 10px", background: "#fff", color: "#183e3a" };
const DAILY_MARKETING_LIMIT = 50;
const FALLBACK_SERVICES = [
  ["spotify", "Spotify"], ["ai", "AI 会员"], ["netflix", "Netflix"], ["disney", "Disney+"],
  ["proxy-pay", "全球代付"], ["rocket", "机场节点"], ["max", "HBO Max"],
].map(([key, name]) => ({ key, name }));
const CTA_OPTIONS = [
  ["/shop", "全部服务"], ["/service-center", "服务中心"], ["/account", "个人中心"], ["/guides", "使用指南"],
];

const CAMPAIGN_STATUS_LABELS = {
  draft: "草稿", scheduled: "已排期", sending: "发送中", paused: "已暂停",
  completed: "已完成", cancelled: "已取消", failed: "失败",
};

const ERROR_LABELS = {
  invalid_email: "收件人名单中没有可用邮箱",
  invalid_segment: "收件人条件无效，请重新选择后核对",
  invalid_segment_sources: "收件人范围无效，请刷新后重试",
  invalid_schedule: "计划发送时间无效，请至少提前 5 分钟",
  audience_truncated: "收件人名单未完整读取或超过本次人数上限，当前不能排期",
  audience_changed: "收件人名单已变化，请重新核对后再排期",
  mail_preview_changed: "邮件内容或商品目录已变化，请重新预览后再排期",
  offer_snapshot_changed: "活动有效期或邮件设置已变化，请重新预览后再排期",
  audience_preview_required: "请先核对完整收件人名单，再排期营销活动",
  marketing_catalog_unavailable: "商品目录暂时无法读取，当前不能预览或排期",
  marketing_catalog_empty: "当前没有可用于营销邮件的在售商品，不能排期",
  mail_policy_unavailable: "退订与投递限制暂时无法读取，请稍后重试",
  campaign_conflict: "活动 ID 已存在且内容不同，请刷新活动 ID 后重试",
  storage_failed: "活动暂时无法保存，请稍后重试",
  policy_unavailable: "退订与投递限制暂时无法读取，请稍后重试",
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

function manualRecipientCount(value) {
  return new Set(String(value || "").split(/[,，;\n\r]+/).map((item) => item.trim().toLowerCase()).filter(Boolean)).size;
}

function requestError(code, fallback) {
  return ERROR_LABELS[code] || fallback || "请求失败，请稍后重试";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function hasFiniteAttribution(attribution) {
  return isRecord(attribution)
    && ["saleCount", "revenue", "conversionRate", "clickThroughRate"].every((key) => (
      typeof attribution[key] === "number" && Number.isFinite(attribution[key])
    ))
    && (!Object.hasOwn(attribution, "orderIds") || (
      Array.isArray(attribution.orderIds) && attribution.orderIds.every((id) => typeof id === "string")
    ));
}

function hasNumericCounters(counters) {
  return isRecord(counters) && Object.values(counters).every((value) => typeof value === "number" && Number.isFinite(value));
}

export function campaignsFromPayload(payload) {
  const valid = isRecord(payload)
    && payload.ok === true
    && Array.isArray(payload.campaigns)
    && payload.campaigns.every((campaign) => (
      isRecord(campaign)
      && typeof campaign.id === "string"
      && Boolean(campaign.id.trim())
      && hasNumericCounters(campaign.counters)
      && hasFiniteAttribution(campaign.attribution)
    ));
  if (!valid) throw new Error("服务器返回的活动列表格式异常，已保留当前列表");
  return payload.campaigns;
}

export function campaignStatsFromPayload(payload, expectedCampaignId) {
  const expectedId = String(expectedCampaignId || "").trim();
  const valid = isRecord(payload)
    && payload.ok === true
    && isRecord(payload.campaign)
    && typeof payload.campaign.id === "string"
    && Boolean(expectedId)
    && payload.campaign.id === expectedId
    && hasNumericCounters(payload.counters)
    && hasFiniteAttribution(payload.attribution);
  if (!valid) throw new Error("服务器返回的活动统计格式异常，未更新当前统计");
  return payload;
}

export function campaignActionFromPayload(kind, payload) {
  if (!isRecord(payload) || payload.ok !== true) throw new Error("服务器返回内容无法识别，请稍后重试");
  if (kind === "preview") {
    if (typeof payload.html !== "string" || !payload.html.trim() || !isSha256(payload.contentHash) || !isSha256(payload.offerSnapshotHash)) {
      throw new Error("邮件预览返回不完整，请重新生成预览");
    }
  } else if (kind === "audience") {
    const snapshot = payload.audience?.snapshot;
    const counts = ["candidateCount", "matchedCount", "eligibleCount", "selectedCount", "suppressedCount", "invalidManualCount"];
    if (!isRecord(payload.audience) || !isSha256(payload.audience.snapshotHash) || !isRecord(snapshot)
        || !counts.every((key) => isNonNegativeInteger(snapshot[key]))
        || !["truncated", "sourceTruncated", "manualTruncated"].every((key) => typeof snapshot[key] === "boolean")
        || snapshot.selectedCount > snapshot.eligibleCount) {
      throw new Error("收件人核对结果不完整，请重新核对");
    }
  } else if (kind === "schedule") {
    if (!isNonNegativeInteger(payload.scheduledCount) || !isNonNegativeInteger(payload.suppressedCount)) {
      throw new Error("排期结果不完整，请刷新活动列表确认后重试");
    }
  }
  return payload;
}

export function campaignManagementFromPayload(payload, expectedCampaignId, action) {
  const expectedStatus = { pause: "paused", resume: "scheduled", cancel: "cancelled" }[action];
  const valid = isRecord(payload)
    && payload.ok === true
    && isRecord(payload.campaign)
    && payload.campaign.id === expectedCampaignId
    && Boolean(expectedStatus)
    && payload.campaign.status === expectedStatus;
  if (!valid) throw new Error("活动状态返回格式异常，请刷新列表确认后重试");
  return payload;
}

export default function MarketingCampaignPanel() {
  const [form, setForm] = useState({
    campaignId: campaignId(), name: "", subject: "本期数字服务精选｜按需要选择合适方案", scheduledAt: localSchedule(),
    audienceServiceKeys: [], featuredServiceKeys: ["spotify", "ai", "rocket"], manualRecipients: "",
    lastPurchaseWithinDays: "", minSpend: "", expiryWithinDays: "", maxRecipients: 2000,
    badge: "本期服务精选", headline: "按需要选择合适的数字服务",
    description: "我们整理了当前可用的服务与起售价格，点击即可查看规格、周期和下单说明。",
    endsAt: "", ctaLabel: "查看全部服务", ctaPath: "/shop",
  });
  const [catalogOptions, setCatalogOptions] = useState(FALLBACK_SERVICES);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [audience, setAudience] = useState(null);
  const [audiencePreviewSignature, setAudiencePreviewSignature] = useState("");
  const [preview, setPreview] = useState("");
  const [mailContentHash, setMailContentHash] = useState("");
  const [offerSnapshotHash, setOfferSnapshotHash] = useState("");
  const [mailPreviewSignature, setMailPreviewSignature] = useState("");
  const [campaigns, setCampaigns] = useState([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError] = useState("");
  const [selectedStats, setSelectedStats] = useState(null);
  const [statsError, setStatsError] = useState("");
  const [statsRetryCampaign, setStatsRetryCampaign] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [state, setState] = useState({ busy: "", message: "", error: "" });
  const campaignsRequestRef = useRef(0);
  const statsRequestRef = useRef(0);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const toggleKey = (field, key, checked) => setForm((current) => ({
    ...current,
    [field]: checked ? Array.from(new Set([...current[field], key])) : current[field].filter((item) => item !== key),
  }));
  const manualCount = useMemo(() => manualRecipientCount(form.manualRecipients), [form.manualRecipients]);
  const segment = useMemo(() => ({
    sources: ["registered", "order_contact", ...(manualCount ? ["manual"] : [])],
    locales: [],
    serviceKeys: form.audienceServiceKeys,
    lastPurchaseWithinDays: form.lastPurchaseWithinDays || null,
    minSpend: form.minSpend || null,
    expiryWithinDays: form.expiryWithinDays || null,
  }), [form.audienceServiceKeys, form.lastPurchaseWithinDays, form.minSpend, form.expiryWithinDays, manualCount]);
  const dateValidation = useMemo(
    () => validateMarketingCampaignDates({ scheduledAt: form.scheduledAt, endsAt: form.endsAt }),
    [form.scheduledAt, form.endsAt],
  );
  const offer = useMemo(() => ({
    badge: form.badge,
    headline: form.headline,
    description: form.description,
    endsAt: dateValidation.endsAtIso,
    ctaLabel: form.ctaLabel,
    ctaPath: form.ctaPath,
    featuredServiceKeys: form.featuredServiceKeys,
  }), [form.badge, form.headline, form.description, form.ctaLabel, form.ctaPath, form.featuredServiceKeys, dateValidation.endsAtIso]);
  const currentMailSignature = useMemo(() => JSON.stringify({ subject: form.subject, offer }), [form.subject, offer]);
  const currentAudienceSignature = useMemo(() => JSON.stringify({ segment, manualRecipients: form.manualRecipients, maxRecipients: Number(form.maxRecipients || 2000) }), [segment, form.manualRecipients, form.maxRecipients]);
  const mailPreviewCurrent = Boolean(preview && mailContentHash && offerSnapshotHash && mailPreviewSignature === currentMailSignature);
  const audiencePreviewCurrent = Boolean(audience?.snapshotHash && audiencePreviewSignature === currentAudienceSignature);
  const selectedCount = audiencePreviewCurrent ? Number(audience?.snapshot?.selectedCount || 0) : 0;
  const audienceTruncated = Boolean(audiencePreviewCurrent && (audience?.snapshot?.truncated || audience?.snapshot?.manualTruncated || audience?.snapshot?.sourceTruncated));
  const estimatedDays = Math.max(1, Math.ceil(selectedCount / DAILY_MARKETING_LIMIT));

  const loadCatalog = useCallback(async () => {
    setPreview("");
    setMailContentHash("");
    setOfferSnapshotHash("");
    setMailPreviewSignature("");
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const response = await fetch("/api/catalog", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("商品目录加载失败");
      const options = (data.products || []).filter((product) => (
        product?.active !== false
        && product?.key
        && (product.plans || []).some((plan) => plan?.active !== false && !plan?.soldOut)
      ))
        .map((product) => ({ key: product.key, name: product.title || product.key }));
      if (!options.length) throw new Error("商品目录暂时为空");
      setCatalogOptions(options);
      setForm((current) => {
        const available = new Set(options.map((item) => item.key));
        const featured = current.featuredServiceKeys.filter((key) => available.has(key));
        return { ...current, featuredServiceKeys: featured.length ? featured : options.slice(0, 3).map((item) => item.key) };
      });
    } catch (error) {
      setCatalogError(error.message || "商品目录加载失败，预览时将由服务端再次读取");
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadCampaigns = useCallback(async () => {
    const requestId = beginLatestRequest(campaignsRequestRef);
    setCampaignsLoading(true);
    setCampaignsError("");
    try {
      const response = await fetch("/api/admin/mail/campaigns?limit=30&includeAttribution=1", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data?.ok !== true) throw new Error(requestError(data?.error, "活动列表加载失败"));
      const nextCampaigns = campaignsFromPayload(data);
      if (!isLatestRequest(campaignsRequestRef, requestId)) return;
      setCampaigns(nextCampaigns);
    } catch (error) {
      if (isLatestRequest(campaignsRequestRef, requestId)) setCampaignsError(error.message || "活动列表加载失败");
    } finally {
      if (isLatestRequest(campaignsRequestRef, requestId)) setCampaignsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCampaigns().catch(() => {});
    loadCatalog().catch(() => {});
    return () => {
      invalidateLatestRequest(campaignsRequestRef);
      invalidateLatestRequest(statsRequestRef);
    };
  }, [loadCampaigns, loadCatalog]);

  async function request(kind, url, payload) {
    setState({ busy: kind, message: "", error: "" });
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      let data = null;
      try { data = await response.json(); } catch { throw new Error("服务器返回内容无法识别，请稍后重试"); }
      if (!response.ok || data?.ok !== true) throw new Error(requestError(data?.error));
      const validated = campaignActionFromPayload(kind, data);
      setState({ busy: "", message: kind === "schedule" ? `已排期 ${validated.scheduledCount} 封，跳过 ${validated.suppressedCount} 个受限地址` : "已更新", error: "" });
      return validated;
    } catch (error) {
      setState({ busy: "", message: "", error: error.message || "请求失败，请稍后重试" });
      return null;
    }
  }

  async function previewMail() {
    if (!dateValidation.ok && form.endsAt) {
      setState({ busy: "", message: "", error: dateValidation.error });
      return;
    }
    const signature = currentMailSignature;
    setMailContentHash("");
    setOfferSnapshotHash("");
    setMailPreviewSignature("");
    const data = await request("preview", "/api/admin/mail/preview", { template: "service_selection_edm_v7", subject: form.subject, offer });
    if (data) {
      setPreview(data.html || "");
      setMailContentHash(data.contentHash || "");
      setOfferSnapshotHash(data.offerSnapshotHash || "");
      setMailPreviewSignature(signature);
    }
  }

  async function previewAudience() {
    const signature = currentAudienceSignature;
    setAudiencePreviewSignature("");
    const data = await request("audience", "/api/admin/mail/audience", {
      segment,
      manualRecipients: form.manualRecipients,
      limit: form.maxRecipients,
    });
    if (data) {
      setAudience(data.audience);
      setAudiencePreviewSignature(signature);
    }
  }

  async function schedule() {
    if (!dateValidation.ok) {
      setState({ busy: "", message: "", error: dateValidation.error });
      return;
    }
    if (!mailPreviewCurrent || !audiencePreviewCurrent || selectedCount < 1 || audienceTruncated) {
      if (audienceTruncated) {
        setState({ busy: "", message: "", error: "当前名单未完整读取或超过本次人数上限，请按名单提示处理后重新核对" });
        return;
      }
      setState({ busy: "", message: "", error: "请先按当前内容完成邮件预览和收件人核对" });
      return;
    }
    const confirmed = window.confirm(`确认排期“${form.name || form.subject}”？\n\n可发送 ${selectedCount} 人；Resend 每天最多 ${DAILY_MARKETING_LIMIT} 封，预计至少 ${estimatedDays} 天完成。`);
    if (!confirmed) return;
    const data = await request("schedule", "/api/admin/mail/campaign", {
      campaignId: form.campaignId,
      name: form.name || form.subject,
      subject: form.subject,
      scheduledAt: dateValidation.scheduledIso,
      template: "service_selection_edm_v7",
      locale: "zh",
      segment,
      manualRecipients: form.manualRecipients,
      maxRecipients: Number(form.maxRecipients || 2000),
      audienceSnapshotHash: audience.snapshotHash,
      mailContentHash,
      offerSnapshotHash,
      offer,
    });
    if (data) {
      setForm((current) => ({ ...current, campaignId: campaignId() }));
      setAudience(null);
      setAudiencePreviewSignature("");
      setPreview("");
      setMailContentHash("");
      setOfferSnapshotHash("");
      setMailPreviewSignature("");
      setEditorOpen(false);
      await loadCampaigns();
    }
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
      if (!response.ok || data?.ok !== true) throw new Error(requestError(data?.error, "活动状态更新失败"));
      campaignManagementFromPayload(data, campaign.id, action);
      setState({ busy: "", message: `活动已${labels[action] || "更新"}`, error: "" });
      await loadCampaigns();
      if (selectedStats?.campaign?.id === campaign.id) await viewStats(campaign);
    } catch (error) {
      setState({ busy: "", message: "", error: error.message || "活动状态更新失败" });
    }
  }

  async function viewStats(campaign) {
    const requestId = beginLatestRequest(statsRequestRef);
    setStatsError("");
    setStatsRetryCampaign(campaign);
    setState({ busy: `stats:${campaign.id}`, message: "", error: "" });
    try {
      const response = await fetch(`/api/admin/mail/campaigns/${encodeURIComponent(campaign.id)}/stats`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data?.ok !== true) throw new Error(requestError(data?.error, "活动统计加载失败"));
      const nextStats = campaignStatsFromPayload(data, campaign.id);
      if (!isLatestRequest(statsRequestRef, requestId)) return;
      setSelectedStats(nextStats);
      setStatsError("");
      setStatsRetryCampaign(null);
      setState({ busy: "", message: "统计已刷新", error: "" });
    } catch (error) {
      if (isLatestRequest(statsRequestRef, requestId)) {
        setStatsError(error.message || "活动统计加载失败");
        setState({ busy: "", message: "", error: "" });
      }
    }
  }

  function closeStats() {
    invalidateLatestRequest(statsRequestRef);
    setSelectedStats(null);
    setStatsError("");
    setStatsRetryCampaign(null);
    setState((current) => String(current.busy || "").startsWith("stats:") ? { busy: "", message: "", error: "" } : current);
  }

  const servicePicker = (field, selected, label) => <fieldset className="marketing-campaign-service-picker wide">
    <legend>{label}</legend>
    <div>{catalogOptions.map((service) => <label key={service.key}>
      <input type="checkbox" checked={selected.includes(service.key)} onChange={(event) => toggleKey(field, service.key, event.target.checked)} />
      <span>{service.name}</span>
    </label>)}</div>
  </fieldset>;

  return <section className="marketing-campaign-panel">
    <div className="marketing-campaign-card marketing-campaign-intro" style={card}>
      <div><h2>营销活动</h2><p>从真实商品目录生成邮件；系统会合并名单、去重并跳过退订、退信和投诉地址。</p></div>
      <ol aria-label="营销活动使用步骤">
        <li><b>1</b><span><strong>核对邮件</strong><small>内容和商品来自当前站点</small></span></li>
        <li><b>2</b><span><strong>核对收件人</strong><small>名单与站内用户合并去重</small></span></li>
        <li><b>3</b><span><strong>确认排期</strong><small>Resend 每天最多 50 封</small></span></li>
      </ol>
    </div>

    {state.error ? <div className="marketing-campaign-feedback error" role="alert">{state.error}</div> : state.message ? <div className="marketing-campaign-feedback success" role="status">{state.message}</div> : null}

    <div className="marketing-campaign-card marketing-campaign-list" style={card}>
      <div className="marketing-campaign-section-head"><div><h3>最近活动</h3><small>查看进度、暂停排期或打开统计</small></div><button type="button" onClick={loadCampaigns} disabled={Boolean(state.busy) || campaignsLoading} style={{ ...input, width: "auto", cursor: "pointer" }}>{campaignsLoading ? "加载中…" : "刷新列表"}</button></div>
      {campaignsError ? <div role="alert" className="marketing-campaign-inline-error">活动列表未更新：{campaignsError}。请点击“刷新列表”重试。</div> : null}
      <div className="marketing-campaign-table-scroll"><table><thead><tr>{["活动", "状态", "计划时间", "入队", "送达", "点击", "收入", "转化率", "点击率", "操作"].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{campaignsLoading && campaigns.length === 0 ? <tr><td colSpan={10} className="marketing-campaign-empty">活动列表加载中…</td></tr> : campaignsError && campaigns.length === 0 ? <tr><td colSpan={10} className="marketing-campaign-empty error">活动列表加载失败，当前空白不代表没有活动</td></tr> : campaigns.length === 0 ? <tr><td colSpan={10} className="marketing-campaign-empty">暂无营销活动</td></tr> : campaigns.map((campaign) => <tr key={campaign.id}>
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
      {statsError && statsRetryCampaign ? <div role="alert" className="marketing-campaign-inline-error">统计未更新：{statsError}。<button type="button" onClick={() => viewStats(statsRetryCampaign)} disabled={Boolean(state.busy)}>重试统计</button></div> : null}
    </div>

    {selectedStats ? <div className="marketing-campaign-card marketing-campaign-stats" style={card}>
      <div className="marketing-campaign-section-head"><div><h3>{selectedStats.campaign.name || selectedStats.campaign.id} · 活动统计</h3><small>最近一次营销邮件点击后 30 天内的订单归因</small></div><div><button type="button" onClick={() => viewStats(selectedStats.campaign)} disabled={Boolean(state.busy)} style={{ ...input, width: "auto" }}>刷新统计</button><button type="button" onClick={closeStats} style={{ ...input, width: "auto" }}>关闭</button></div></div>
      <div className="marketing-campaign-stat-grid">{[
        ["入队", selectedStats.counters?.queued || 0], ["已提交", selectedStats.counters?.submitted || 0], ["已送达", selectedStats.counters?.delivered || 0], ["唯一点击", selectedStats.counters?.uniqueClicks || 0],
        ["投诉", selectedStats.counters?.complained || 0], ["退订", selectedStats.counters?.unsubscribed || 0], ["成交订单", selectedStats.attribution?.saleCount || 0], ["活动收入", `¥${Number(selectedStats.attribution?.revenue || 0).toFixed(2)}`],
        ["点击转化率", `${selectedStats.attribution?.conversionRate || 0}%`], ["邮件点击率", `${selectedStats.attribution?.clickThroughRate || 0}%`],
      ].map(([label, value]) => <div key={label}><div>{label}</div><strong>{value}</strong></div>)}</div>
      {selectedStats.attribution?.orderIds?.length ? <p className="marketing-campaign-order-ids">归因订单：{selectedStats.attribution.orderIds.join("、")}</p> : null}
    </div> : null}

    <details className="marketing-campaign-create" open={editorOpen} onToggle={(event) => setEditorOpen(event.currentTarget.open)}>
      <summary><span><strong>{editorOpen ? "正在新建营销活动" : "新建营销活动"}</strong><small>{editorOpen ? "邮件和收件人都核对后才能确认排期" : "展开设置内容、收件人和发送时间"}</small></span><em>{editorOpen ? "收起" : "开始创建"}</em></summary>
      <div className="marketing-campaign-create-body">
        <div className="marketing-campaign-card marketing-campaign-basics" style={card}>
          <div className="marketing-campaign-card-title"><h2>基本设置</h2><small>活动 ID 仅用于关联投递、退订和收入统计。</small></div>
          <div className="marketing-campaign-basics-grid">
            <label>活动 ID<input style={input} value={form.campaignId} readOnly aria-readonly="true" /></label>
            <label>活动名称<input style={input} value={form.name} onChange={set("name")} placeholder="八月服务精选" /></label>
            <label>开始排期<input style={input} type="datetime-local" value={form.scheduledAt} onChange={set("scheduledAt")} /></label>
            <label>最多收件人<input style={input} type="number" min="1" max="2000" value={form.maxRecipients} onChange={set("maxRecipients")} /></label>
          </div>
          <p role="note" className="marketing-campaign-schedule-note">系统在下一次队列巡检时开始发送；营销邮件固定使用 Resend，每个北京时间自然日最多提交 {DAILY_MARKETING_LIMIT} 封，超出的名单自动顺延到后续日期。</p>
          <label className="marketing-campaign-subject">邮件主题<input style={input} value={form.subject} onChange={set("subject")} /></label>
        </div>

        <div className="marketing-campaign-card marketing-campaign-editor" style={card}>
          <div className="marketing-campaign-offer"><h3>邮件内容</h3><p>商品名称、起售价格和结算优惠由服务端读取；这里不能手填与结算不一致的促销价格或代码。</p><div className="marketing-campaign-field-grid">
            <label>顶部标签<input style={input} value={form.badge} onChange={set("badge")} /></label>
            <label>主按钮文字<input style={input} value={form.ctaLabel} onChange={set("ctaLabel")} /></label>
            <label className="wide">主标题<input style={input} value={form.headline} onChange={set("headline")} /></label>
            <label className="wide">简短说明<textarea style={{ ...input, minHeight: 76, resize: "vertical" }} value={form.description} onChange={set("description")} /></label>
            {servicePicker("featuredServiceKeys", form.featuredServiceKeys, "邮件重点展示服务（最多展示前 3 项）")}
            <label>最晚派发时间（可选）<input style={input} type="datetime-local" value={form.endsAt} onChange={set("endsAt")} /><small>超时未发的邮件将停止，不改变站内价格。</small></label>
            <label>主按钮前往<select style={input} value={form.ctaPath} onChange={set("ctaPath")}>{CTA_OPTIONS.map(([path, label]) => <option key={path} value={path}>{label}</option>)}</select></label>
          </div></div>

          <div className="marketing-campaign-segment"><h3>收件人</h3><p>固定合并手工名单、全部注册账号与全部历史下单邮箱；重复地址只保留一份。</p><div className="marketing-campaign-field-grid">
            <label className="wide">手工名单（每行一个，也可用逗号分隔）<textarea className="marketing-campaign-recipient-list" style={input} value={form.manualRecipients} onChange={set("manualRecipients")} placeholder="name@example.com" /><small>当前输入 {manualCount} 个地址；格式无效、退订、硬退信或投诉地址会被跳过。</small></label>
            {servicePicker("audienceServiceKeys", form.audienceServiceKeys, "仅筛选站内用户：购买过的服务（不选则不限；手工名单始终保留）")}
            <label>最近购买（天内）<input style={input} type="number" min="0" value={form.lastPurchaseWithinDays} onChange={set("lastPurchaseWithinDays")} placeholder="留空不限" /></label>
            <label>最低累计消费（元）<input style={input} type="number" min="0" value={form.minSpend} onChange={set("minSpend")} placeholder="留空不限" /></label>
            <label>服务到期（天内）<input style={input} type="number" value={form.expiryWithinDays} onChange={set("expiryWithinDays")} placeholder="留空不限" /></label>
            <div className="marketing-campaign-language"><strong>邮件正文</strong><span>中文（本模板仅生成中文正文）</span></div>
            {audiencePreviewCurrent ? <div className={`marketing-campaign-audience wide${audienceTruncated ? " stale" : ""}`}>
              <strong>{audienceTruncated ? "名单超过当前上限，暂不能排期" : `可发送 ${audience.snapshot.selectedCount}`}</strong><span>合并匹配 {audience.snapshot.matchedCount} · 已选择 {audience.snapshot.selectedCount} · 因退订/退信/投诉跳过 {audience.snapshot.suppressedCount} · 手工无效 {audience.snapshot.invalidManualCount || 0} · 预计至少 {estimatedDays} 天</span>
              {audienceTruncated ? <span>{audience.snapshot.sourceTruncated ? "完整名单来源已超过系统读取容量，调整本页人数或筛选条件无法保证覆盖；请先扩充服务端名单读取容量后重新核对。" : "已匹配人数超过本次上限；可提高“最多收件人”后重新核对，若超过 2000 请分批处理并逐批核对。"}</span> : null}
            </div> : audience ? <div className="marketing-campaign-audience stale wide">收件人条件已改变，请重新核对。</div> : null}
          </div></div>
        </div>

        {catalogError ? <div className="marketing-campaign-inline-error" role="alert">{catalogError}。<button type="button" onClick={loadCatalog} disabled={catalogLoading}>{catalogLoading ? "重试中…" : "重新读取"}</button></div> : null}
        <div className="marketing-campaign-actions">
          <button type="button" onClick={previewAudience} disabled={Boolean(state.busy)} style={{ ...input, width: "auto", cursor: "pointer" }}>{state.busy === "audience" ? "核对中…" : "核对收件人"}</button>
          <button type="button" onClick={previewMail} disabled={Boolean(state.busy)} style={{ ...input, width: "auto", cursor: "pointer" }}>{state.busy === "preview" ? "生成中…" : "预览邮件"}</button>
          <button type="button" onClick={schedule} disabled={Boolean(state.busy) || !dateValidation.ok || !mailPreviewCurrent || !audiencePreviewCurrent || selectedCount < 1 || audienceTruncated} className="marketing-campaign-primary">{state.busy === "schedule" ? "排期中…" : "确认并排期"}</button>
          {!dateValidation.ok ? <span role="alert" className="marketing-campaign-action-error">{dateValidation.error}</span> : audienceTruncated ? <span role="alert" className="marketing-campaign-action-error">名单未完整读取或超过本次人数上限，不能排期</span> : !mailPreviewCurrent || !audiencePreviewCurrent ? <span className="marketing-campaign-action-hint">内容或收件人改变后需要重新核对</span> : null}
        </div>
        {mailPreviewCurrent ? <details className="marketing-campaign-card marketing-campaign-preview" style={card} open><summary>邮件预览</summary><iframe title="营销邮件预览" sandbox="" srcDoc={preview} /></details> : preview ? <div className="marketing-campaign-audience stale">邮件内容已改变，请重新预览。</div> : null}
      </div>
    </details>
  </section>;
}
