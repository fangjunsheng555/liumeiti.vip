"use client";

import { useEffect, useState } from "react";
import { LoaderCircle, MailCheck, RefreshCw, Send, X } from "lucide-react";
import styles from "./ServiceNoticeDialog.module.css";

const ERROR_TEXT = {
  announcement_not_found: "未找到这条公告",
  service_not_selected: "请先为公告选择关联服务",
  service_not_found: "关联服务已不存在，请重新选择",
  announcement_copy_required: "请先补充完整的中文标题和正文",
  english_copy_required: "相关用户中包含英文用户，请先补充英文标题和正文",
  no_recipients: "目前没有符合条件的相关用户",
};

export default function ServiceNoticeDialog({ post, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/announce-posts/${encodeURIComponent(post.id)}/notify`, { cache: "no-store", credentials: "same-origin" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(ERROR_TEXT[result.error] || "无法读取通知范围");
      setData(result);
    } catch (err) {
      setError(err.message || "无法读取通知范围");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [post.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function requestSend(retry = false) {
    const prompt = retry
      ? "确认重试未送达的服务通知？"
      : `确认向 ${Number(data?.audience?.total || 0)} 位相关用户发送这封服务通知？`;
    if (typeof window !== "undefined" && !window.confirm(prompt)) return;
    setSending(true);
    setError("");
    try {
      let result = data;
      let guard = 0;
      do {
        const response = await fetch(`/api/admin/announce-posts/${encodeURIComponent(post.id)}/notify`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retry }),
        });
        result = await response.json();
        if (!response.ok || !result.ok) throw new Error(ERROR_TEXT[result.error] || "服务通知发送失败");
        setData(result);
        guard += 1;
      } while (!retry && result.hasMore && guard < 100);
    } catch (err) {
      const message = err.message || "服务通知发送失败";
      await load();
      setError(message);
    } finally {
      setSending(false);
    }
  }

  const total = Number(data?.delivery?.total || data?.audience?.total || 0);
  const sent = Number(data?.delivery?.sent || 0);
  const failed = Number(data?.delivery?.failed || 0);
  const pending = Number(data?.delivery?.pending || 0);
  const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !sending && onClose()}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="service-notice-title">
        <header className={styles.header}>
          <div className={styles.heading}>
            <span className={styles.kicker}>服务通知</span>
            <h3 id="service-notice-title">{data?.service?.label || "相关用户通知"}</h3>
          </div>
          <button type="button" className={styles.close} onClick={onClose} disabled={sending} aria-label="关闭"><X size={16} /></button>
        </header>

        {loading ? (
          <div className={styles.loading}><LoaderCircle size={17} className="spin-icon" />正在确认收件范围</div>
        ) : (
          <>
            <div className={styles.body}>
              <p className={styles.announcement}>{data?.announcement?.title || post.title}</p>
              {data && (
                <div className={styles.stats}>
                  <div><span>相关用户</span><strong>{data.audience.total}</strong></div>
                  <div><span>中文</span><strong>{data.audience.zh}</strong></div>
                  <div><span>English</span><strong>{data.audience.en}</strong></div>
                </div>
              )}
              <p className={styles.note}>仅通知已付款且订单有效的相关用户。同一邮箱仅发送一次，商品页不会显示此通知。</p>
              {data && total === 0 && <p className={styles.warning}>目前没有符合条件的相关用户。</p>}
              {data && !data.englishCopyReady && <p className={styles.warning}>请先补充英文标题和正文，再发送通知。</p>}
              {data && (sent > 0 || failed > 0 || pending < total) && (
                <>
                  <div className={styles.progress}><i style={{ width: `${percent}%` }} /></div>
                  <p className={failed ? styles.warning : styles.success}>
                    已送达 {sent}{pending > 0 ? ` · 待发送 ${pending}` : ""}{failed > 0 ? ` · 未送达 ${failed}` : ""}
                  </p>
                </>
              )}
              {error && <p className={styles.error}>{error}</p>}
            </div>
            <footer className={styles.actions}>
              <button type="button" onClick={onClose} disabled={sending}>关闭</button>
              {failed > 0 && <button type="button" className={styles.retry} onClick={() => requestSend(true)} disabled={sending}><RefreshCw size={14} />重试未送达</button>}
              {pending > 0 && (
                <button type="button" className={styles.primary} onClick={() => requestSend(false)} disabled={sending || !data?.englishCopyReady || total === 0}>
                  {sending ? <LoaderCircle size={14} className="spin-icon" /> : sent > 0 ? <MailCheck size={14} /> : <Send size={14} />}
                  {sending ? "发送中" : sent > 0 ? "继续发送" : "发送通知"}
                </button>
              )}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
