"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";
import { useLocale } from "./LocaleProvider";
import {
  createPendingIdempotencyRecord,
  idempotencyFingerprint,
  isExplicitTerminalIdempotencyResponse,
} from "../lib/idempotency";
import { withCheckoutSubmissionCoordination } from "../lib/checkout-pending-journal";
import { clientFetch as fetch } from "../lib/client-fetch";

export default function SpotifyPasswordUpdate({ orderId }) {
  const { locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const [token, setToken] = useState("");
  const [details, setDetails] = useState(null);
  const [form, setForm] = useState({ account: "", password: "", email: "", contact: "", remark: "" });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const updateRequestRef = useRef(null);

  function errorMessage(code) {
    return {
      invalid_update_link: L("更新链接无效，请联系客服重新获取", "This update link is invalid. Contact support for a new one."),
      update_link_expired: L("更新链接已过期，请联系客服重新获取", "This update link has expired. Contact support for a new one."),
      update_link_used: L("该更新链接已使用，请联系客服重新申请新的链接", "This update link has already been used. Contact support for a new one."),
      order_not_found: L("未找到对应订单", "Order not found."),
      order_invalid: L("订单已失效，无法更新", "This order can no longer be updated."),
      account_required: L("请填写 Spotify 账号", "Enter the Spotify account."),
      password_required: L("请填写准确的 Spotify 密码", "Enter the correct Spotify password."),
      invalid_email: L("请填写有效的下单邮箱", "Enter a valid order email."),
      contact_required: L("请填写联系方式", "Enter your contact details."),
      save_failed: L("保存失败，请稍后重试", "Couldn't save. Try again shortly."),
      stale_revision: L(
        "订单刚被其他操作更新，请保留当前填写内容并稍后重试；如已刷新页面，请重新打开原链接确认结果",
        "The order was just changed by another operation. Keep these exact fields and retry shortly; if you refreshed, reopen the original link to verify the result.",
      ),
      order_update_busy: L("订单资料正在更新，请保持原内容并稍后重试", "The order is being updated. Keep the same fields and retry shortly."),
      idempotency_conflict: L("待提交资料与原请求不一致，请勿反复提交并联系客服核对", "The pending details conflict with the original request. Do not resubmit; contact support."),
    }[code] || L("无法读取更新链接", "Couldn't open this update link.");
  }

  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token") || "";
    setToken(value);
    if (!value) {
      setError(errorMessage("invalid_update_link"));
      setLoading(false);
      return;
    }
    fetch(`/api/order-password-update/${encodeURIComponent(orderId)}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${value}` },
    })
      .then(async (response) => ({ response, data: await response.json() }))
      .then(({ response, data }) => {
        if (!response.ok || !data.ok) throw new Error(errorMessage(data.error));
        setDetails(data.details);
        if (data.resolved) {
          setCompleted(true);
          return;
        }
        setForm({
          account: data.details.account || "",
          password: "",
          email: data.details.email || "",
          contact: data.details.contact || "",
          remark: data.details.remark || "",
        });
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (!token || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await withCheckoutSubmissionCoordination(async () => {
        const payload = { ...form };
        const identity = { orderId: String(orderId || "").toUpperCase(), token };
        const fingerprint = idempotencyFingerprint("spotify-password-update", { identity, payload });
        let pending = updateRequestRef.current;
        if (pending && pending.idempotencyRequest?.fingerprint !== fingerprint) {
          throw new Error(L(
            "上一次提交结果尚未确认，请恢复原内容后重试；如已刷新页面，请先重新打开原链接核对结果。",
            "The previous submission is still unresolved. Restore its exact fields and retry; if you reloaded, reopen the original link to verify the result.",
          ));
        }
        if (!pending) {
          pending = createPendingIdempotencyRecord(null, "spotify-password-update", payload, { identity });
          updateRequestRef.current = pending;
        }
        const operation = pending.idempotencyRequest;
        const response = await fetch(`/api/order-password-update/${encodeURIComponent(orderId)}`, {
          method: "PATCH",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": operation.key,
          },
          body: JSON.stringify(pending.payload),
        });
        let data = null;
        try { data = await response.json(); } catch {}
        if (!response.ok || !data?.ok) {
          if (isExplicitTerminalIdempotencyResponse(response.status, data)) updateRequestRef.current = null;
          throw new Error(errorMessage(data?.error));
        }
        updateRequestRef.current = null;
        setDetails(data.details);
        setForm((current) => ({ ...current, password: "" }));
        setCompleted(true);
      });
    } catch (requestError) {
      setError(requestError.message || errorMessage("save_failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="spotify-update-page">
      <header className="spotify-update-header">
        <Link href="/" aria-label={L("返回首页", "Home")}><Image src="/email-logo.png" alt="冒央会社" width={176} height={39} priority /></Link>
        <Link href="/service-center" className="spotify-update-back"><ArrowLeft size={14} />{L("服务中心", "Service Center")}</Link>
      </header>

      <section className="spotify-update-panel">
        {loading ? (
          <div className="spotify-update-state"><LoaderCircle size={24} className="spin-icon" /><span>{L("正在读取订单资料", "Loading order details")}</span></div>
        ) : error && !details ? (
          <div className="spotify-update-state error"><LockKeyhole size={25} /><strong>{error}</strong><Link href="/service-center">{L("前往服务中心", "Open Service Center")}</Link></div>
        ) : completed ? (
          <div className="spotify-update-state success"><CheckCircle2 size={42} /><h1>{L("资料提交成功", "Details submitted")}</h1><p>{L("客服已收到最新资料，将继续处理您的订单。", "Our support team has received the updated details and will continue processing your order.")}</p><Link href="/service-center">{L("查看订单", "View order")}</Link></div>
        ) : (
          <>
            <div className="spotify-update-title">
              <span>Spotify · {L("订单资料更新", "Order details update")}</span>
              <h1>{L("更新 Spotify 登录信息", "Update Spotify login details")}</h1>
              <p>{L("请重新填写正确密码；如账号或联系方式有变，也可一并更新。", "Enter the correct password and update any account or contact details that have changed.")}</p>
              <code>{details?.orderId}</code>
            </div>
            <form className="spotify-update-form" onSubmit={submit}>
              <label>
                <span>{L("Spotify 账号", "Spotify account")}</span>
                <input value={form.account} onChange={(event) => update("account", event.target.value)} autoComplete="username" maxLength={80} required />
              </label>
              <label>
                <span className="spotify-update-label-row">
                  <span>{L("Spotify 密码", "Spotify password")}</span>
                  <a href="https://accounts.spotify.com/en/password-reset" target="_blank" rel="noopener noreferrer">{L("忘记 Spotify 密码？点击找回", "Forgot Spotify password? Reset it")}</a>
                </span>
                <div className="spotify-update-password">
                  <input type={showPassword ? "text" : "password"} value={form.password} onChange={(event) => update("password", event.target.value)} placeholder={L("填写正确的 Spotify 密码", "Enter the correct Spotify password")} autoComplete="current-password" maxLength={120} required />
                  <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? L("隐藏密码", "Hide password") : L("显示密码", "Show password")}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
                </div>
              </label>
              <div className="spotify-update-divider" />
              <label>
                <span>{L("下单邮箱", "Order email")}</span>
                <input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} autoComplete="email" inputMode="email" maxLength={200} required />
              </label>
              <label>
                <span>{L("联系方式", "Contact")}</span>
                <input value={form.contact} onChange={(event) => update("contact", event.target.value)} autoComplete="tel" maxLength={200} required />
              </label>
              <label>
                <span>{L("备注（选填）", "Note (optional)")}</span>
                <textarea value={form.remark} onChange={(event) => update("remark", event.target.value)} rows={2} maxLength={1500} />
              </label>
              {error && <p className="spotify-update-error">{error}</p>}
              <button type="submit" className="spotify-update-submit" disabled={submitting}>{submitting ? <LoaderCircle size={16} className="spin-icon" /> : <CheckCircle2 size={16} />}{submitting ? L("正在提交", "Submitting") : L("提交更新", "Submit update")}</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
