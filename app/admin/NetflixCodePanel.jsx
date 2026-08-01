"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Mail,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import styles from "./NetflixCodePanel.module.css";

const REASON_LABELS = {
  supported_content_not_found: "未识别到支持的验证码或链接",
  six_digit_rejected: "已拒绝 6 位验证码",
  sensitive_six_digit: "敏感操作邮件已拒绝",
  ambiguous_code: "邮件中存在多个候选验证码",
  mime_parse_failed: "邮件格式无法解析",
  account_email_missing: "未识别到账号邮箱",
};

function time(value) {
  return String(value || "").replace(" 北京时间 (UTC+8)", "") || "--";
}

export default function NetflixCodePanel({ canEdit = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("mail");
  const [busyKey, setBusyKey] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [copiedResult, setCopiedResult] = useState("");
  const requestRef = useRef(0);

  const load = useCallback(async ({ silent = false, query: nextQuery = "" } = {}) => {
    const requestId = ++requestRef.current;
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (nextQuery.trim()) params.set("q", nextQuery.trim());
      const response = await fetch(`/api/admin/netflix-code${params.size ? `?${params}` : ""}`, { credentials: "same-origin", cache: "no-store" });
      const next = await response.json();
      if (!response.ok || !next?.ok) throw new Error(next?.error || "load_failed");
      if (requestId !== requestRef.current) return;
      setData(next);
      setNotice("");
    } catch {
      if (requestId !== requestRef.current) return;
      setNotice("接码记录读取失败，请稍后重试");
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => load({ silent: true, query }), query ? 260 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  const acceptedCount = useMemo(() => Number(data?.recentAcceptedCount ?? (data?.events || []).filter((event) => event.accepted).length), [data]);

  async function update(action, order, enabled) {
    if (!canEdit || !order?.orderId || busyKey) return;
    const key = `${action}:${order.orderId}`;
    setBusyKey(key);
    setNotice("");
    try {
      const response = await fetch("/api/admin/netflix-code", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, orderId: order.orderId, enabled }),
      });
      const result = await response.json();
      if (!response.ok || !result?.ok) throw new Error(result?.error || "save_failed");
      await load({ silent: true, query });
    } catch {
      setNotice("操作未保存，请稍后重试");
    } finally {
      setBusyKey("");
    }
  }

  async function removeRecords(action, recordIds, label) {
    if (!canEdit || !recordIds?.length || busyKey) return;
    if (!window.confirm(`删除这条${label}？此操作不可撤销。`)) return;
    const key = `${action}:${recordIds[0]}`;
    setBusyKey(key);
    setNotice("");
    try {
      const response = await fetch("/api/admin/netflix-code", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, recordIds }),
      });
      const result = await response.json();
      if (!response.ok || !result?.ok) throw new Error(result?.error || "delete_failed");
      await load({ silent: true, query });
    } catch {
      setNotice("记录未删除，请稍后重试");
    } finally {
      setBusyKey("");
    }
  }

  async function copyParsedResult(value, eventId) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedResult(eventId);
      window.setTimeout(() => setCopiedResult(""), 1500);
    } catch {
      setNotice("复制失败，请手动打开结果");
    }
  }

  return (
    <section className={styles.panel}>
      <header className={styles.header}>
        <div><span><KeyRound size={14} />Netflix 自助接码</span><h1>收件与接码记录</h1><p>核对邮件解析、账号匹配与成功接码记录。</p></div>
        <button type="button" onClick={() => load({ query })} disabled={loading}><RefreshCw size={14} />刷新</button>
      </header>

      <div className={styles.meta}>
        <div><span>收件地址</span><b>{data?.inboxAddress || "未配置"}</b></div>
        <div><span>Netflix 订单</span><b>{Number(data?.orderCount || 0)}</b></div>
        <div><span>近期有效邮件</span><b>{acceptedCount}</b></div>
        <div className={data?.configured ? styles.ready : styles.warning}><span>服务状态</span><b>{data?.configured ? "可用" : "待配置"}</b></div>
      </div>

      <div className={styles.recordTools}>
        <div className={styles.tabs} role="tablist" aria-label="Netflix 接码记录">
          <button type="button" className={tab === "mail" ? styles.active : ""} onClick={() => setTab("mail")}><Mail size={14} />收件记录</button>
          <button type="button" className={tab === "access" ? styles.active : ""} onClick={() => setTab("access")}><LockKeyhole size={14} />成功记录</button>
          <button type="button" className={tab === "accounts" ? styles.active : ""} onClick={() => setTab("accounts")}><Clock3 size={14} />账号状态</button>
        </div>
        <div className={styles.searchBox}>
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索邮箱、Netflix 账号或订单号" aria-label="搜索接码记录" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索" title="清除搜索"><X size={13} /></button>}
        </div>
      </div>

      {notice && <div className={styles.notice}><ShieldAlert size={14} />{notice}</div>}
      {loading && !data ? <div className={styles.loading}><LoaderCircle size={18} className="spin-icon" />正在读取…</div> : null}

      {tab === "mail" && data && (
        <div className={styles.table}>
          <div className={styles.tableHead}><span>收件时间</span><span>Netflix 账号</span><span>使用订单</span><span>解析结果</span></div>
          {(data.events || []).length ? data.events.map((event) => {
            const accountEmails = event.accountEmails || event.accountHints || [];
            return <article key={event.eventId} className={styles.row}>
              <div className={styles.when}>
                <b>{event.kind === "code" ? <KeyRound size={13} /> : (event.kind === "link" || event.kind === "household") ? <Link2 size={13} /> : <ShieldAlert size={13} />}{time(event.receivedAtBeijing)}</b>
                <small>{event.language || "--"}</small>
              </div>
              <div className={styles.accounts}>{accountEmails.length ? accountEmails.map((email) => <span key={email} title={email}>{email}</span>) : <span>未匹配</span>}</div>
              <div className={styles.orders}>{(event.orders || []).length ? event.orders.map((order) => (
                <div key={order.orderId}>
                  <span><b>{order.orderId}</b><small>{order.email}</small></span>
                  {canEdit && <details className={styles.actionMenu}>
                    <summary>管理</summary>
                    <div className={styles.actions}>
                      <button type="button" onClick={() => update("toggle_order", order, !order.enabled)} disabled={Boolean(busyKey)}>{order.enabled ? "停用订单" : "启用订单"}</button>
                      {order.userRegistered && <button type="button" onClick={() => update("toggle_user", order, !order.userEnabled)} disabled={Boolean(busyKey)}>{order.userEnabled ? "停用用户" : "启用用户"}</button>}
                      <button type="button" onClick={() => update("clear_lock", order, true)} disabled={Boolean(busyKey)}>解除限制</button>
                    </div>
                  </details>}
                </div>
              )) : <span className={styles.muted}>{event.matchedOrderCount > 1 ? `${event.matchedOrderCount} 个订单使用此账号` : "暂无关联订单"}</span>}</div>
              <div className={styles.resultCell}>
                <div className={styles.resultValue}>
                  <span className={event.accepted ? styles.ok : styles.rejected}>{event.accepted ? <CheckCircle2 size={13} /> : <ShieldAlert size={13} />}{event.accepted ? (event.kind === "household" ? "同户确认链接已解析" : event.kind === "link" ? "官方链接已解析" : "验证码已解析") : (REASON_LABELS[event.reason] || "未采用")}</span>
                  {event.accepted && event.kind === "code" && event.result && <div className={styles.parsedCode}><code>{event.result}</code><button type="button" onClick={() => copyParsedResult(event.result, event.eventId)}><Copy size={11} />{copiedResult === event.eventId ? "已复制" : "复制"}</button></div>}
                  {event.accepted && (event.kind === "link" || event.kind === "household") && event.result && <div className={styles.parsedActions}><a href={event.result} target="_blank" rel="noopener noreferrer"><ExternalLink size={11} />打开链接</a><button type="button" onClick={() => copyParsedResult(event.result, event.eventId)}><Copy size={11} />{copiedResult === event.eventId ? "已复制" : "复制链接"}</button></div>}
                </div>
                {canEdit && <button type="button" className={styles.deleteButton} onClick={() => removeRecords("delete_mail_records", event.eventIds?.length ? event.eventIds : [event.eventId], "收件记录")} disabled={Boolean(busyKey)} aria-label="删除收件记录" title="删除收件记录"><Trash2 size={13} /></button>}
              </div>
            </article>;
          }) : <div className={styles.empty}>{query ? "没有符合条件的收件记录" : "暂无收件记录"}</div>}
        </div>
      )}

      {tab === "access" && data && (
        <div className={styles.table}>
          <div className={`${styles.tableHead} ${styles.accessGrid}`}><span>时间</span><span>用户邮箱</span><span>订单号</span><span>Netflix 账号</span></div>
          {(data.access || []).length ? data.access.map((entry) => (
            <article key={entry.id} className={`${styles.row} ${styles.accessGrid}`}>
              <div className={styles.when}><b><Clock3 size={13} />{time(entry.createdAtBeijing)}</b></div>
              <div className={styles.email}>{entry.userEmail || "--"}</div>
              <div><b className={styles.orderId}>{entry.orderId || "--"}</b></div>
              <div className={`${styles.email} ${styles.accessAccount}`}><span>{entry.accountEmail || "--"}</span>{canEdit && <button type="button" className={styles.deleteButton} onClick={() => removeRecords("delete_access_records", [entry.id], "成功记录")} disabled={Boolean(busyKey)} aria-label="删除成功接码记录" title="删除成功接码记录"><Trash2 size={13} /></button>}</div>
            </article>
          )) : <div className={styles.empty}>{query ? "没有符合条件的成功记录" : "暂无成功接码记录"}</div>}
        </div>
      )}

      {tab === "accounts" && data && (
        <div className={styles.table}>
          <div className={`${styles.tableHead} ${styles.accessGrid}`}><span>Netflix 账号</span><span>最近收信</span><span>关联订单</span><span>转发状态</span></div>
          {(data.accounts || []).length ? data.accounts.map((row) => {
            const ageHours = row.lastMailAt ? (Date.now() - Date.parse(row.lastMailAt)) / 3600000 : null;
            return (
              <article key={row.account} className={`${styles.row} ${styles.accessGrid}`}>
                <div className={styles.email}>{row.account}</div>
                <div className={styles.when}><b><Clock3 size={13} />{time(row.lastMailAtBeijing)}</b></div>
                <div><b className={styles.orderId}>{row.orderCount}</b></div>
                <div>
                  {ageHours === null
                    ? <span className={styles.rejected}><ShieldAlert size={13} />7 天内无收信，建议检查邮箱转发</span>
                    : ageHours <= 72
                      ? <span className={styles.ok}><CheckCircle2 size={13} />收信正常</span>
                      : <span className={styles.muted}>{Math.floor(ageHours / 24)} 天未收信（可能只是无人取码）</span>}
                </div>
              </article>
            );
          }) : <div className={styles.empty}>{query ? "没有符合条件的账号" : "暂无绑定 Netflix 账号的订单"}</div>}
        </div>
      )}

      <footer className={styles.footer}><a href="/netflix-code" target="_blank" rel="noopener noreferrer">查看用户页面<ExternalLink size={13} /></a><span>直接验证码与官方链接均按 15 分钟有效期处理；「账号状态」无收信 = 邮件未到达系统（多为邮箱转发失效），有收件记录但解析失败会显示在收件记录页</span></footer>
    </section>
  );
}
