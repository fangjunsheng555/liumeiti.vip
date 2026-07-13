"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, MailCheck, RefreshCw, Search, X } from "lucide-react";

const STATUS = {
  scheduled: { label: "已排期", tone: "neutral" },
  sent: { label: "已发送", tone: "neutral" },
  delivered: { label: "已送达", tone: "ok" },
  recovered: { label: "重发成功", tone: "ok" },
  delayed: { label: "延迟", tone: "warn" },
  bounced: { label: "退信", tone: "error" },
  complained: { label: "投诉", tone: "error" },
  failed: { label: "失败", tone: "error" },
  suppressed: { label: "已拦截", tone: "error" },
};

const CATEGORY = {
  transactional: "事务邮件",
  marketing: "营销邮件",
  order: "订单通知",
  quote: "代付报价",
  after_sales: "售后工单",
  password_update: "资料更正",
  renewal: "续费提醒",
  service_incident: "服务通知",
  redeem: "兑换码",
  verification: "验证码",
  withdrawal: "提现通知",
  test: "测试邮件",
};

const EVENT_LABEL = {
  "email.sent": "Resend 已接收",
  "email.delivered": "已送达收件服务器",
  "email.delivery_delayed": "投递延迟",
  "email.bounced": "收件服务器退信",
  "email.complained": "收件人标记为垃圾邮件",
  "email.failed": "投递失败",
  "email.suppressed": "地址已被拦截",
  "smtp2go.processed": "SMTP2GO 已接收",
  "smtp2go.delivered": "已送达收件服务器",
  "smtp2go.bounce": "收件服务器退信",
  "smtp2go.spam": "收件人标记为垃圾邮件",
  "smtp2go.reject": "SMTP2GO 已拒绝",
};

function compactTime(value) {
  const match = String(value || "").match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  return match ? `${match[1].slice(5)} ${match[2]}` : String(value || "--");
}

function statusMeta(status) { return STATUS[status] || STATUS.sent; }

function providerLabel(record) {
  if (record?.fallbackAttempted) return "Resend → SMTP2GO";
  if (record?.fallback || record?.provider === "smtp2go") return "SMTP2GO 备用";
  if (record?.provider === "smtp") return "SMTP";
  if (record?.provider === "queue") return "站内排期";
  return "Resend";
}

function eventLabel(type) { return EVENT_LABEL[type] || type || "状态更新"; }

export default function MailDeliveryPanel() {
  const [records, setRecords] = useState([]);
  const [counts, setCounts] = useState({});
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [category, setCategory] = useState("all");
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ status, category, limit: "160" });
      if (appliedQuery) params.set("q", appliedQuery);
      const response = await fetch(`/api/admin/mail-delivery?${params}`, { cache: "no-store", credentials: "same-origin" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "load_failed");
      setRecords(data.records || []);
      setCounts(data.counts || {});
    } catch (error) {
      setMessage(error?.message === "unauthorized" ? "仅超级管理员可查看邮件投递" : "邮件投递记录加载失败");
    } finally {
      setLoading(false);
    }
  }, [status, category, appliedQuery]);

  useEffect(() => { load(); }, [load]);

  function search(event) {
    event.preventDefault();
    setAppliedQuery(query.trim());
  }

  const problemCount = Number(counts.bounced || 0) + Number(counts.complained || 0) + Number(counts.failed || 0) + Number(counts.suppressed || 0);

  return (
    <div className="admin-compact-page">
      <header className="admin-compact-head">
        <div><h2><MailCheck size={18} />邮件投递</h2><p>Resend 主通道与 SMTP2GO 备用通道</p></div>
        <button type="button" onClick={load} disabled={loading} aria-label="刷新邮件投递"><RefreshCw size={14} className={loading ? "spin-icon" : ""} />刷新</button>
      </header>

      <div className="admin-status-strip" aria-label="邮件投递概览">
        <span><b>{records.length}</b>当前结果</span>
        <span className="ok"><b>{Number(counts.delivered || 0)}</b>已送达</span>
        <span><b>{Number(counts.sent || 0)}</b>已发送 · {Number(counts.scheduled || 0)} 排期</span>
        <span className={problemCount ? "error" : ""}><b>{problemCount}</b>异常</span>
      </div>

      <form className="admin-compact-tools" onSubmit={search}>
        <label><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="邮箱 / 主题 / 订单号" /></label>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="投递状态">
          <option value="all">全部状态</option>
          {Object.entries(STATUS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
        </select>
        <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="邮件类型">
          <option value="all">全部类型</option>
          {Object.entries(CATEGORY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="submit">搜索</button>
      </form>

      {message && <div className="admin-inline-error"><AlertTriangle size={14} />{message}</div>}

      <div className="admin-compact-list" aria-busy={loading}>
        {!loading && records.length === 0 ? <div className="admin-compact-empty">暂无匹配的投递记录</div> : records.map((record) => {
          const meta = statusMeta(record.status);
          return (
            <button type="button" key={record.id} className="admin-delivery-row" onClick={() => setSelected(record)}>
              <span className={`admin-state-dot ${meta.tone}`} />
              <span className="admin-delivery-main"><strong>{record.to || "收件人未记录"}</strong><small>{record.subject || "无主题"}</small></span>
              <span className="admin-delivery-related">
                <span className="admin-delivery-meta"><em>{providerLabel(record)}</em>{CATEGORY[record.category] || record.category || "事务邮件"}</span>
                {record.relatedId ? <small>{record.relatedId}</small> : null}
              </span>
              <span className={`admin-state-label ${meta.tone}`}>{meta.label}</span>
              <time>{compactTime(record.updatedAtBeijing || record.createdAtBeijing)}</time>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="admin-drawer-mask" onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}>
          <aside className="admin-compact-drawer" aria-modal="true" role="dialog" aria-label="邮件投递详情">
            <header><div><span>投递详情</span><strong>{selected.subject || "无主题"}</strong></div><button type="button" onClick={() => setSelected(null)} aria-label="关闭"><X size={18} /></button></header>
            <dl className="admin-compact-detail">
              <div><dt>收件人</dt><dd>{selected.to || "--"}</dd></div>
              <div><dt>类型</dt><dd>{CATEGORY[selected.category] || selected.category || "事务邮件"}</dd></div>
              <div><dt>关联记录</dt><dd>{selected.relatedId || "--"}</dd></div>
              <div><dt>发送服务</dt><dd>{providerLabel(selected)}</dd></div>
              <div><dt>邮件 ID</dt><dd className="mono">{selected.messageId || "--"}</dd></div>
              {selected.providerMessageId && selected.providerMessageId !== selected.messageId
                ? <div><dt>服务商 ID</dt><dd className="mono">{selected.providerMessageId}</dd></div>
                : null}
              <div><dt>当前状态</dt><dd><span className={`admin-state-label ${statusMeta(selected.status).tone}`}>{statusMeta(selected.status).label}</span></dd></div>
              {selected.recoveredAtBeijing ? <div><dt>恢复时间</dt><dd>{selected.recoveredAtBeijing}</dd></div> : null}
              {selected.scheduledAtBeijing ? <div><dt>计划发送</dt><dd>{selected.scheduledAtBeijing}</dd></div> : null}
              {selected.fallback && selected.primaryError ? <div><dt>切换原因</dt><dd>{selected.primaryError}</dd></div> : null}
              {selected.fallbackAttempted && selected.fallbackError ? <div><dt>备用通道</dt><dd className="error-text">{selected.fallbackError}</dd></div> : null}
              {selected.reason ? <div><dt>原因</dt><dd className="error-text">{selected.reason}</dd></div> : null}
            </dl>
            <section className="admin-event-timeline">
              <h3>事件时间线</h3>
              {(selected.events || []).length === 0 ? <p>等待 {providerLabel(selected)} 投递回执</p> : [...selected.events].reverse().map((event) => {
                const meta = statusMeta(event.status || selected.status);
                return <div key={event.id || `${event.type}-${event.createdAt}`}><span className={`admin-state-dot ${meta.tone}`} /><strong>{eventLabel(event.type)}</strong><time>{event.createdAtBeijing || event.createdAt}</time>{event.reason ? <small>{event.reason}</small> : null}</div>;
              })}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
