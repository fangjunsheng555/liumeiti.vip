"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, LoaderCircle } from "lucide-react";
import {
  enableBrowserPush,
  fetchPushAccountStateCached,
  setStockPushWatch,
} from "../lib/push-client";

function messageForError(error, en) {
  const code = String(error?.message || error || "");
  if (["unauthorized", "not_logged_in", "session_missing", "session_invalid"].some((item) => code.includes(item))) {
    return en ? "Sign in first" : "请先登录账户";
  }
  if (code.includes("push_install_required")) {
    return en ? "On iPhone/iPad, add this site to the Home Screen first" : "iPhone/iPad 请先将网站添加到主屏幕";
  }
  if (code.includes("permission_denied")) {
    return en ? "Notifications are blocked in browser settings" : "浏览器已禁止通知，请在设置中开启";
  }
  if (code.includes("push_permission_required")) {
    return en
      ? "Notification permission wasn't granted. Choose Allow in the prompt, or set Notifications to Allow in the site controls beside the address bar."
      : "尚未允许通知。请在权限提示中选择“允许”；若提示已关闭，请从地址栏左侧的网站图标进入“此网站的权限”，把“通知”设为“允许”。";
  }
  if (code.includes("push_permission_prompt_missing")) {
    return en
      ? "No permission result arrived within 15 seconds. If no prompt appeared, open the site controls beside the address bar, set Notifications to Allow, then retry."
      : "15 秒内未收到浏览器权限结果。如果没有看到提示，请点击地址栏左侧的网站图标，进入“此网站的权限”，把“通知”设为“允许”后重试。";
  }
  if (code.includes("push_not_configured") || code.includes("push_disabled")) {
    return en ? "Restock alerts are not available yet" : "到货提醒暂未启用";
  }
  return en ? "Could not save the alert. Try again." : "到货提醒保存失败，请重试";
}

export default function StockAlertButton({ service, plan, locale = "zh" }) {
  const en = locale === "en";
  const productKey = `${String(service || "").toLowerCase()}:${String(plan || "").toLowerCase()}`;
  const [status, setStatus] = useState("checking");
  const [message, setMessage] = useState("");
  const busy = status === "loading";
  const watching = status === "watching";
  const buttonDisabled = busy || ["checking", "unavailable", "available"].includes(status);

  useEffect(() => {
    let cancelled = false;
    fetchPushAccountStateCached()
      .then((state) => {
        if (cancelled) return;
        if (!state.enabled || !state.configured) {
          setStatus("unavailable");
          return;
        }
        setStatus((state.stockWatches || []).includes(productKey) ? "watching" : "idle");
      })
      .catch((error) => {
        if (cancelled) return;
        const code = String(error?.message || "");
        if (["unauthorized", "not_logged_in", "session_missing", "session_invalid"].some((item) => code.includes(item))) {
          setStatus("auth_required");
        } else {
          setStatus("error");
          setMessage(messageForError(error, en));
        }
      });
    return () => { cancelled = true; };
  }, [en, productKey]);

  async function retryAccountState() {
    if (busy) return;
    setStatus("checking");
    setMessage("");
    try {
      const state = await fetchPushAccountStateCached({ refresh: true });
      if (!state.enabled || !state.configured) {
        setStatus("unavailable");
        return;
      }
      setStatus((state.stockWatches || []).includes(productKey) ? "watching" : "idle");
    } catch (error) {
      const code = String(error?.message || "");
      if (["unauthorized", "not_logged_in", "session_missing", "session_invalid"].some((item) => code.includes(item))) {
        setStatus("auth_required");
      } else {
        setStatus("error");
        setMessage(messageForError(error, en));
      }
    }
  }

  async function toggle() {
    if (busy) return;
    if (status === "auth_required") {
      window.location.assign("/account");
      return;
    }
    const wasWatching = watching;
    setStatus("loading");
    setMessage("");
    try {
      if (watching) {
        await setStockPushWatch(service, plan, false);
        setStatus("idle");
        setMessage(en ? "Restock alert removed" : "已取消到货提醒");
        return;
      }
      // The account check ran on mount. The click enters the permission flow
      // immediately so browser user activation is not lost to a network await.
      await enableBrowserPush({ locale });
      const result = await setStockPushWatch(service, plan, true);
      if (result.available) {
        setStatus("available");
        setMessage(en ? "This plan is available now. Refresh to buy." : "该规格已有库存，请刷新后购买");
        return;
      }
      setStatus("watching");
      setMessage(en ? "We will notify this browser when it is back" : "到货后将通知此浏览器");
    } catch (error) {
      // A remove response can be lost after the server committed it. Preserve
      // the previous visible intent so the next click retries the same safe,
      // idempotent removal instead of accidentally re-adding the watch.
      setStatus(wasWatching ? "watching" : "error");
      setMessage(messageForError(error, en));
    }
  }

  return (
    <div style={{ display: "grid", gap: 5, marginTop: -2, marginBottom: 4 }}>
      <button
        type="button"
        onClick={status === "error" ? retryAccountState : toggle}
        disabled={buttonDisabled}
        aria-pressed={watching}
        style={{
          minHeight: 36,
          border: "1px solid rgba(15,118,110,.28)",
          borderRadius: 11,
          background: watching ? "rgba(240,253,250,.96)" : "rgba(255,255,255,.94)",
          color: "#0f766e",
          fontSize: 12,
          fontWeight: 850,
          cursor: busy ? "wait" : buttonDisabled ? "not-allowed" : "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
        }}
      >
        {busy
          ? <LoaderCircle size={14} className="spin" />
          : watching ? <BellOff size={14} /> : <Bell size={14} />}
        {status === "checking"
          ? (en ? "Checking…" : "正在检查…")
          : status === "auth_required"
            ? (en ? "Sign in to set alert" : "登录后设置")
            : status === "unavailable"
              ? (en ? "Restock alerts unavailable" : "到货提醒暂不可用")
              : status === "error"
                ? (en ? "Retry restock alert" : "重试到货提醒")
              : busy
          ? (en ? "Enabling…" : "正在开启…")
          : watching ? (en ? "Remove restock alert" : "取消到货提醒") : (en ? "Notify me when available" : "到货提醒")}
      </button>
      {message && (
        <small
          role={status === "error" ? "alert" : "status"}
          style={{ color: status === "error" ? "#b91c1c" : "#64748b", fontSize: 11 }}
        >
          {message}
        </small>
      )}
    </div>
  );
}
