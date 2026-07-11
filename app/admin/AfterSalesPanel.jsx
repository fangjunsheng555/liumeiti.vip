"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Headphones,
  Inbox,
  LoaderCircle,
  Mail,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";

function compactTime(value) {
  const match = String(value || "").match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : value || "未记录";
}

export default function AfterSalesPanel({ canEdit = false, onChanged }) {
  const [status, setStatus] = useState("pending");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [tickets, setTickets] = useState([]);
  const [counts, setCounts] = useState({ all: 0, pending: 0, completed: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [active, setActive] = useState(null);
  const [detailLoading, setDetailLoading] = useState("");
  const [staffNote, setStaffNote] = useState("");
  const [completing, setCompleting] = useState(false);
  const [result, setResult] = useState(null);

  const loadTickets = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ status, limit: "100" });
      if (appliedSearch) params.set("q", appliedSearch);
      const response = await fetch(`/api/admin/after-sales?${params.toString()}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "load_failed");
      setTickets(data.tickets || []);
      setCounts(data.counts || { all: 0, pending: 0, completed: 0 });
    } catch {
      setError("售后工单加载失败，请稍后刷新");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [status, appliedSearch]);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  useEffect(() => {
    if (!active) return;
    document.body.style.overflow = "hidden";
    const onKey = (event) => { if (event.key === "Escape" && !completing) setActive(null); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = ""; document.removeEventListener("keydown", onKey); };
  }, [active, completing]);

  async function openTicket(ticket) {
    if (!ticket?.ticketId || detailLoading) return;
    setDetailLoading(ticket.ticketId);
    setError("");
    try {
      const response = await fetch(`/api/admin/after-sales/${encodeURIComponent(ticket.ticketId)}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "detail_failed");
      setActive(data.ticket);
      setStaffNote(data.ticket.staffNote || "");
      setResult(null);
    } catch {
      setError("工单详情加载失败，请稍后再试");
    } finally {
      setDetailLoading("");
    }
  }

  async function completeTicket() {
    if (!active || active.status !== "pending" || completing || !canEdit) return;
    setCompleting(true);
    setResult(null);
    try {
      const response = await fetch(`/api/admin/after-sales/${encodeURIComponent(active.ticketId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed", staffNote }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "complete_failed");
      setActive(data.ticket);
      setStaffNote(data.ticket.staffNote || "");
      setResult(data.changed === false
        ? { type: "success", message: "工单已由其他工作人员完成，未重复发送邮件" }
        : {
            type: data.notice?.email ? "success" : "warning",
            message: data.notice?.email ? "工单已完成，完成邮件已发送给用户" : "工单已完成，但邮件暂未送达，请核对发信服务",
          });
      await loadTickets({ silent: true });
      onChanged?.();
    } catch {
      setResult({ type: "error", message: "完成工单失败，请稍后再试" });
    } finally {
      setCompleting(false);
    }
  }

  return (
    <section className="admin-after-sales-page">
      <header className="admin-after-sales-header">
        <div>
          <span className="admin-after-sales-kicker"><Headphones size={14} />交易售后</span>
          <h1>售后工单</h1>
          <p>处理用户从订单详情提交的售后申请，完成后系统自动发送结果邮件。</p>
        </div>
        <button type="button" className="admin-after-sales-refresh" onClick={() => loadTickets()} disabled={loading}><RefreshCw size={14} />刷新</button>
      </header>

      <div className="admin-after-sales-stats">
        <div><span>待处理</span><b>{counts.pending}</b><em className="pending"><Clock3 size={13} />需要跟进</em></div>
        <div><span>已完成</span><b>{counts.completed}</b><em><CheckCircle2 size={13} />处理完成</em></div>
        <div><span>全部工单</span><b>{counts.all}</b><em><Inbox size={13} />历史累计</em></div>
      </div>

      <div className="admin-after-sales-tools">
        <div className="admin-after-sales-tabs" role="tablist" aria-label="工单状态">
          {[
            ["pending", `待处理 ${counts.pending}`],
            ["completed", `已完成 ${counts.completed}`],
            ["all", `全部 ${counts.all}`],
          ].map(([value, label]) => (
            <button key={value} type="button" className={status === value ? "active" : ""} onClick={() => setStatus(value)}>{label}</button>
          ))}
        </div>
        <form onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search.trim()); }} className="admin-after-sales-search">
          <Search size={14} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="工单号 / 订单号 / 邮箱 / 服务" />
          <button type="submit">搜索</button>
        </form>
      </div>

      {error && <div className="admin-after-sales-alert error"><AlertCircle size={15} />{error}</div>}
      {loading ? (
        <div className="admin-after-sales-loading"><LoaderCircle size={22} className="spin-icon" /><span>正在加载工单</span></div>
      ) : tickets.length === 0 ? (
        <div className="admin-after-sales-empty"><Inbox size={32} /><strong>{appliedSearch ? "未找到匹配工单" : status === "pending" ? "暂无待处理工单" : "暂无工单记录"}</strong><span>{appliedSearch ? "请检查搜索内容" : "新工单提交后会显示在这里"}</span></div>
      ) : (
        <div className="admin-after-sales-list">
          {tickets.map((ticket) => (
            <button type="button" key={ticket.ticketId} className={`admin-after-sales-card status-${ticket.status}`} onClick={() => openTicket(ticket)} disabled={Boolean(detailLoading)}>
              <span className="admin-after-sales-card-mark">{detailLoading === ticket.ticketId ? <LoaderCircle size={17} className="spin-icon" /> : ticket.status === "completed" ? <CheckCircle2 size={17} /> : <Clock3 size={17} />}</span>
              <div className="admin-after-sales-card-main">
                <div className="admin-after-sales-card-top">
                  <code>{ticket.ticketId}</code>
                  <em>{ticket.status === "completed" ? "已完成" : "待处理"}</em>
                </div>
                <strong>{ticket.serviceLabel || "订单售后"}</strong>
                <p>{ticket.issue}</p>
                <div className="admin-after-sales-card-meta"><span>{ticket.email}</span><span>{compactTime(ticket.createdAtBeijing)}</span></div>
              </div>
              <div className="admin-after-sales-card-order"><span>关联订单</span><code>{ticket.orderId}</code></div>
            </button>
          ))}
        </div>
      )}

      {active && (
        <div className="admin-after-sales-modal-mask" onClick={() => !completing && setActive(null)}>
          <article className="admin-after-sales-modal" role="dialog" aria-modal="true" aria-labelledby="admin-after-sales-title" onClick={(event) => event.stopPropagation()}>
            <header className="admin-after-sales-modal-head">
              <div>
                <span className="admin-after-sales-kicker"><Headphones size={14} />售后工单详情</span>
                <h2 id="admin-after-sales-title">{active.serviceLabel || "订单售后"}</h2>
                <div className="admin-after-sales-modal-identifiers"><code>{active.ticketId}</code><span>关联</span><code>{active.orderId}</code></div>
              </div>
              <button type="button" onClick={() => setActive(null)} disabled={completing} aria-label="关闭"><X size={19} /></button>
            </header>
            <div className="admin-after-sales-modal-body">
              <div className={`admin-after-sales-status-banner ${active.status}`}>
                {active.status === "completed" ? <CheckCircle2 size={18} /> : <Clock3 size={18} />}
                <div><strong>{active.status === "completed" ? "工单已完成" : "等待工作人员处理"}</strong><span>{active.status === "completed" ? compactTime(active.completedAtBeijing) : compactTime(active.createdAtBeijing)}</span></div>
              </div>

              <section className="admin-after-sales-detail-section issue">
                <h3>用户问题说明</h3>
                <p>{active.issue}</p>
              </section>

              <section className="admin-after-sales-detail-section">
                <h3>联系与订单资料</h3>
                <dl className="admin-after-sales-detail-grid">
                  <div><dt>下单邮箱</dt><dd><Mail size={13} />{active.email || "--"}</dd></div>
                  <div><dt>联系方式</dt><dd>{active.contact || "--"}</dd></div>
                  <div className="wide"><dt>用户备注</dt><dd>{active.remark || "未填写"}</dd></div>
                </dl>
              </section>

              <section className="admin-after-sales-detail-section">
                <h3>用户提交的服务资料</h3>
                <div className="admin-after-sales-item-list">
                  {(active.items || []).map((item, index) => (
                    <div className="admin-after-sales-item" key={`${item.service}-${index}`}>
                      <div className="admin-after-sales-item-head"><span>{index + 1}</span><strong>{item.label}</strong></div>
                      {(item.account || item.password) && <div className="admin-after-sales-item-fields">
                        {item.account && <div><span>账号</span><code>{item.account}</code></div>}
                        {item.password && <div><span>密码</span><code>{item.password}</code></div>}
                      </div>}
                      {(item.platformUrl || item.productPrice) && <div className="admin-after-sales-item-fields">
                        {item.platformUrl && <div className="wide"><span>网站 / 平台</span><a href={item.platformUrl} target="_blank" rel="noopener noreferrer">{item.platformUrl}<ExternalLink size={12} /></a></div>}
                        {item.productPrice && <div><span>商品标价</span><b>{item.productPrice}</b></div>}
                      </div>}
                      {!item.account && !item.password && !item.platformUrl && !item.productPrice && <p>该服务下单时无额外必填配置。</p>}
                    </div>
                  ))}
                </div>
              </section>

              <section className="admin-after-sales-detail-section admin-after-sales-resolution">
                <h3>处理结果</h3>
                {active.status === "pending" ? (
                  <label>
                    <span>客服处理备注 <em>选填，完成邮件会同步发送给用户</em></span>
                    <textarea value={staffNote} onChange={(event) => setStaffNote(event.target.value)} maxLength={2000} placeholder="例如：已重新配置服务，请用户按邮件说明重新登录" disabled={!canEdit || completing} />
                    <small>{staffNote.length}/2000</small>
                  </label>
                ) : (
                  <div className="admin-after-sales-completed-note">{active.staffNote || "本工单完成时未填写客服备注。"}</div>
                )}
              </section>

              {result && <div className={`admin-after-sales-alert ${result.type}`}>{result.type === "success" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}{result.message}</div>}
            </div>
            {active.status === "pending" && (
              <footer className="admin-after-sales-modal-actions">
                <div><ShieldCheck size={14} /><span>完成后解除该订单的待处理限制，并向用户发送结果邮件</span></div>
                <button type="button" onClick={completeTicket} disabled={!canEdit || completing}>
                  {completing ? <LoaderCircle size={15} className="spin-icon" /> : <CheckCircle2 size={15} />}
                  {completing ? "正在完成" : canEdit ? "完成工单并通知用户" : "无处理权限"}
                </button>
              </footer>
            )}
          </article>
        </div>
      )}
    </section>
  );
}
