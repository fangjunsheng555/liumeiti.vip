"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  ExternalLink,
  KeyRound,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Mail,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import styles from "./NetflixCodePanel.module.css";

const OUTCOME_LABELS = {
  authorized: "身份核验通过",
  waiting: "等待邮件",
  code_returned: "已返回 4 位验证码",
  travel_link_returned: "已返回官方临时代码链接",
  temporarily_locked: "频率限制",
  verification_required: "身份未核验",
  account_changed: "订单账号已变更",
  unsafe_result_rejected: "不安全内容已拒绝",
  self_service_disabled: "自助接码已停用",
};

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

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/admin/netflix-code", { credentials: "same-origin", cache: "no-store" });
      const next = await response.json();
      if (!response.ok || !next?.ok) throw new Error(next?.error || "load_failed");
      setData(next);
      setNotice("");
    } catch {
      setNotice("接码记录读取失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const acceptedCount = useMemo(() => (data?.events || []).filter((event) => event.accepted).length, [data]);

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
      await load({ silent: true });
    } catch {
      setNotice("操作未保存，请稍后重试");
    } finally {
      setBusyKey("");
    }
  }

  return (
    <section className={styles.panel}>
      <header className={styles.header}>
        <div><span><KeyRound size={14} />Netflix 自助接码</span><h1>收件与访问记录</h1><p>核对邮件解析、订单匹配与用户读取记录；后台不会显示验证码或链接令牌。</p></div>
        <button type="button" onClick={() => load()} disabled={loading}><RefreshCw size={14} />刷新</button>
      </header>

      <div className={styles.meta}>
        <div><span>收件地址</span><b>{data?.inboxAddress || "未配置"}</b></div>
        <div><span>Netflix 订单</span><b>{Number(data?.orderCount || 0)}</b></div>
        <div><span>近期有效邮件</span><b>{acceptedCount}</b></div>
        <div className={data?.configured ? styles.ready : styles.warning}><span>服务状态</span><b>{data?.configured ? "可用" : "待配置"}</b></div>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Netflix 接码记录">
        <button type="button" className={tab === "mail" ? styles.active : ""} onClick={() => setTab("mail")}><Mail size={14} />收件记录</button>
        <button type="button" className={tab === "access" ? styles.active : ""} onClick={() => setTab("access")}><LockKeyhole size={14} />用户访问</button>
      </div>

      {notice && <div className={styles.notice}><ShieldAlert size={14} />{notice}</div>}
      {loading && !data ? <div className={styles.loading}><LoaderCircle size={18} className="spin-icon" />正在读取…</div> : null}

      {tab === "mail" && data && (
        <div className={styles.table}>
          <div className={styles.tableHead}><span>时间 / 类型</span><span>匹配账号</span><span>关联订单</span><span>状态</span></div>
          {(data.events || []).length ? data.events.map((event) => (
            <article key={event.eventId} className={styles.row}>
              <div className={styles.when}>
                <b>{event.kind === "code" ? <KeyRound size={13} /> : event.kind === "link" ? <Link2 size={13} /> : <ShieldAlert size={13} />}{event.kind === "code" ? "4 位验证码" : event.kind === "link" ? "官方临时代码链接" : "未采用"}</b>
                <small>{time(event.receivedAtBeijing)} · {event.language || "--"}</small>
              </div>
              <div className={styles.accounts}>{(event.accountHints || []).length ? event.accountHints.map((hint) => <span key={hint}>{hint}</span>) : <span>未匹配</span>}</div>
              <div className={styles.orders}>{(event.orders || []).length ? event.orders.map((order) => (
                <div key={order.orderId}>
                  <span><b>{order.orderId}</b><small>{order.email}</small></span>
                  {canEdit && <div className={styles.actions}>
                    <button type="button" onClick={() => update("toggle_order", order, !order.enabled)} disabled={Boolean(busyKey)}>{order.enabled ? "停用订单" : "启用订单"}</button>
                    {order.userRegistered && <button type="button" onClick={() => update("toggle_user", order, !order.userEnabled)} disabled={Boolean(busyKey)}>{order.userEnabled ? "停用用户" : "启用用户"}</button>}
                    <button type="button" onClick={() => update("clear_lock", order, true)} disabled={Boolean(busyKey)}>解除限制</button>
                  </div>}
                </div>
              )) : <span className={styles.muted}>暂无关联订单</span>}</div>
              <div className={event.accepted ? styles.ok : styles.rejected}>{event.accepted ? <CheckCircle2 size={13} /> : <ShieldAlert size={13} />}{event.accepted ? "已安全解析" : (REASON_LABELS[event.reason] || "已拒绝")}</div>
            </article>
          )) : <div className={styles.empty}>暂无收件记录</div>}
        </div>
      )}

      {tab === "access" && data && (
        <div className={styles.table}>
          <div className={`${styles.tableHead} ${styles.accessGrid}`}><span>时间</span><span>订单 / 账号</span><span>操作</span><span>结果</span></div>
          {(data.access || []).length ? data.access.map((entry) => (
            <article key={entry.id} className={`${styles.row} ${styles.accessGrid}`}>
              <div className={styles.when}><b><Clock3 size={13} />{time(entry.createdAtBeijing)}</b><small>{entry.actorType === "guest" ? "订单邮箱核验" : entry.actorType === "admin" ? "后台" : "登录用户"}</small></div>
              <div><b className={styles.orderId}>{entry.orderId || "--"}</b><small className={styles.block}>{entry.accountHint || "--"}</small></div>
              <div className={styles.muted}>{entry.action === "authorize" ? "核验订单" : "读取邮件"}</div>
              <div className={entry.outcome === "code_returned" || entry.outcome === "travel_link_returned" || entry.outcome === "authorized" ? styles.ok : styles.outcome}>{OUTCOME_LABELS[entry.outcome] || entry.outcome || "--"}</div>
            </article>
          )) : <div className={styles.empty}>暂无用户访问记录</div>}
        </div>
      )}

      <footer className={styles.footer}><a href="/netflix-code" target="_blank" rel="noopener noreferrer">查看用户页面<ExternalLink size={13} /></a><span>直接验证码与官方链接均按 15 分钟有效期处理</span></footer>
    </section>
  );
}
