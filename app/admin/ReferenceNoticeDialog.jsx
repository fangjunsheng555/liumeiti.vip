"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, LoaderCircle, Mail, Search, X } from "lucide-react";
import styles from "./ReferenceNoticeDialog.module.css";

export default function ReferenceNoticeDialog({ open, onClose, onSent }) {
  const [reference, setReference] = useState("");
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [subject, setSubject] = useState("客服通知");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setSelected(new Set());
    setNotice(null);
    setMessage("");
  }, [open]);

  const selectedCount = useMemo(() => selected.size, [selected]);

  async function searchReference(event) {
    event?.preventDefault();
    const normalized = reference.trim().toUpperCase();
    if (!normalized || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/after-sales/notify-by-reference?reference=${encodeURIComponent(normalized)}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "search_failed");
      setPreview(data);
      setSelected(new Set((data.orders || []).map((order) => order.orderId)));
      if (!(data.orders || []).length) setNotice({ type: "info", text: "未找到可通知的有效订单" });
    } catch {
      setPreview(null);
      setSelected(new Set());
      setNotice({ type: "error", text: "查询失败，请检查编号后重试" });
    } finally {
      setBusy(false);
    }
  }

  function toggle(orderId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  async function sendNotice() {
    if (!preview || !selectedCount || subject.trim().length < 2 || message.trim().length < 2 || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/after-sales/notify-by-reference", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: preview.reference, orderIds: Array.from(selected), subject, message }),
      });
      const data = await response.json();
      if (!response.ok || (!data.ok && !data.partial)) throw new Error(data.error || "send_failed");
      setNotice({ type: data.partial ? "info" : "success", text: `已送达 ${data.delivered} / ${data.total} 个邮箱` });
      onSent?.();
    } catch {
      setNotice({ type: "error", text: "邮件发送失败，请检查发信状态后重试" });
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className={styles.mask} onClick={() => !busy && onClose()}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="reference-notice-title" onClick={(event) => event.stopPropagation()}>
        <header className={styles.header}>
          <div><span><Mail size={13} />按内部编号通知</span><h2 id="reference-notice-title">发送客服通知</h2></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={18} /></button>
        </header>

        <div className={styles.body}>
          <form className={styles.search} onSubmit={searchReference}>
            <label><span>内部编号</span><input value={reference} onChange={(event) => setReference(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32))} placeholder="输入订单内部编号" /></label>
            <button type="submit" disabled={busy || !reference.trim()}>{busy && !preview ? <LoaderCircle size={14} className="spin-icon" /> : <Search size={14} />}查询</button>
          </form>

          {preview && (
            <>
              <div className={styles.summary}><b>{preview.orders.length} 个订单</b><span>{preview.recipients.length} 个收件邮箱</span></div>
              <div className={styles.orders}>
                {preview.orders.map((order) => (
                  <label key={order.orderId} className={selected.has(order.orderId) ? styles.checked : ""}>
                    <input type="checkbox" checked={selected.has(order.orderId)} onChange={() => toggle(order.orderId)} />
                    <span><b>{order.serviceLabel || "订单"}</b><small>{order.orderId} · {order.email}</small></span>
                    <em>{order.currency === "USDT" ? `${order.amount} USDT` : `¥${order.amount.toFixed(2)}`}</em>
                  </label>
                ))}
              </div>
              <label className={styles.field}><span>邮件标题</span><input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={160} /></label>
              <label className={styles.field}><span>客服通知</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={2000} rows={5} placeholder="填写需要告知用户的内容；最新账号资料与订单备注会自动附在邮件中。" /></label>
            </>
          )}
          {notice && <div className={`${styles.notice} ${styles[notice.type]}`}>{notice.type === "success" && <CheckCircle2 size={14} />}{notice.text}</div>}
        </div>

        <footer className={styles.footer}>
          <span>每个邮箱仅收到与其本人相关的订单</span>
          <button type="button" onClick={sendNotice} disabled={busy || !preview || !selectedCount || subject.trim().length < 2 || message.trim().length < 2}>
            {busy && preview ? <LoaderCircle size={14} className="spin-icon" /> : <Mail size={14} />}
            发送 {selectedCount || ""}
          </button>
        </footer>
      </section>
    </div>
  );
}
