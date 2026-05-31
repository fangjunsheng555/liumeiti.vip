"use client";

import { useEffect, useState } from "react";
import { Copy, Gift, LoaderCircle, RefreshCw, X } from "lucide-react";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="oauth-provider-icon">
      <path fill="#4285F4" d="M21.6 12.23c0-.74-.07-1.45-.19-2.13H12v4.03h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.43Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.34l-3.24-2.51c-.9.6-2.05.95-3.38.95-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A9.99 9.99 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 13.98A6.01 6.01 0 0 1 6.08 12c0-.69.12-1.35.32-1.98V7.43H3.06A9.99 9.99 0 0 0 2 12c0 1.61.39 3.13 1.06 4.57l3.34-2.59Z" />
      <path fill="#EA4335" d="M12 5.9c1.47 0 2.79.51 3.83 1.5l2.87-2.87C16.96 2.91 14.7 2 12 2a9.99 9.99 0 0 0-8.94 5.43l3.34 2.59C7.19 7.66 9.4 5.9 12 5.9Z" />
    </svg>
  );
}

function normalizeRedeemCode(value) {
  return String(value || "").replace(/\s+/g, "").replace(/[＿_—–]/g, "-").toUpperCase();
}

export default function RedeemCard({ autoFillFromQuery = false }) {
  const [authUser, setAuthUser] = useState(null);
  const [authModal, setAuthModal] = useState(null);
  const [authForm, setAuthForm] = useState({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
  const [authCaptcha, setAuthCaptcha] = useState({ a: 0, b: 0 });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [redeemInput, setRedeemInput] = useState("");
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [redeemStatus, setRedeemStatus] = useState(null);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => setAuthUser(d.ok ? { email: d.email, username: d.username, balance: Number(d.balance || 0) } : false))
      .catch(() => setAuthUser(false));
  }, []);

  useEffect(() => {
    if (!autoFillFromQuery || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = normalizeRedeemCode(params.get("redeem") || "").replace(/[^A-Z0-9]/g, "");
    if (code) {
      setRedeemInput(code);
      setRedeemStatus({ type: "info", message: "已为您填入兑换码，点击「立即兑换」按钮即可使用" });
      setTimeout(() => document.getElementById("redeem")?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
    }
  }, [autoFillFromQuery]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.style.overflow = authModal ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [authModal]);

  useEffect(() => {
    if (authModal === "register") {
      setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) });
    }
    if (!authModal) setAuthForm({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
  }, [authModal]);

  async function pasteRedeem() {
    try {
      const text = await navigator.clipboard?.readText?.();
      const next = normalizeRedeemCode(text);
      if (!next) {
        setRedeemStatus({ type: "error", message: "剪贴板里没有可用的兑换码" });
        return;
      }
      setRedeemInput(next);
      if (redeemStatus?.type === "error") setRedeemStatus(null);
    } catch {
      setRedeemStatus({ type: "error", message: "无法读取剪贴板,请长按输入框手动粘贴" });
    }
  }

  async function submitRedeem(event) {
    event.preventDefault();
    const code = redeemInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) {
      setRedeemStatus({ type: "error", message: "请输入兑换码" });
      return;
    }
    setRedeemBusy(true);
    setRedeemStatus({ type: "info", message: "正在识别兑换码..." });
    try {
      const infoRes = await fetch(`/api/redeem-code?code=${encodeURIComponent(code)}`, { cache: "no-store" });
      const info = await infoRes.json();
      if (!infoRes.ok || !info.ok || info.status !== "active") {
        setRedeemStatus({ type: "error", message: info.message || "兑换码不存在、已使用或已作废" });
        return;
      }
      if (info.type === "service") {
        window.location.href = `/checkout?redeem=${encodeURIComponent(code)}`;
        return;
      }
      if (!authUser || authUser === false) {
        setAuthModal("login");
        setAuthNotice("余额兑换码需要先登录账号，登录后再次点击兑换即可到账");
        setRedeemStatus({ type: "error", message: "余额兑换码需要登录账号后兑换" });
        return;
      }
      const res = await fetch("/api/auth/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!data.ok) {
        setRedeemStatus({ type: "error", message: data.message || "兑换失败,请联系客服" });
        return;
      }
      setAuthUser((cur) => cur && cur !== false ? { ...cur, balance: Number(data.balance || cur.balance || 0) } : cur);
      setRedeemInput("");
      setRedeemStatus({ type: "success", message: `兑换成功，余额已到账，当前余额 ¥${Number(data.balance || 0).toFixed(2)}` });
    } catch {
      setRedeemStatus({ type: "error", message: "兑换失败,请稍后再试" });
    } finally {
      setRedeemBusy(false);
    }
  }

  async function doAuth(event) {
    event.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      let payload = {};
      if (authModal === "login") payload = { email: authForm.email.trim(), password: authForm.password };
      if (authModal === "register") payload = {
        email: authForm.email.trim(),
        password: authForm.password,
        captchaA: authCaptcha.a,
        captchaB: authCaptcha.b,
        captchaAnswer: Number(authForm.captchaAnswer),
      };
      if (authModal === "forgot") payload = { email: authForm.email.trim() };
      if (authModal === "reset") payload = {
        email: authForm.email.trim(),
        code: authForm.code.trim(),
        newPassword: authForm.newPassword,
      };
      const res = await fetch(`/api/auth/${authModal}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (authModal === "forgot") {
        setAuthNotice("验证码已发送至邮箱。请查看收件箱(或垃圾邮件)");
        setAuthModal("reset");
        setAuthForm((f) => ({ ...f, code: "", newPassword: "" }));
        return;
      }
      if (data.ok) {
        setAuthUser({ email: data.email, username: data.username || "", balance: Number(data.balance || 0) });
        setAuthModal(null);
        return;
      }
      const msg = {
        captcha_failed: "人机验证失败,请重新计算",
        email_taken: "该邮箱已注册",
        invalid_email: "邮箱格式错误",
        password_length: "密码 6-64 位",
        invalid_credentials: "邮箱或密码错误",
        invalid_code: "验证码格式错误(6 位数字)",
        code_invalid_or_expired: "验证码错误或已过期",
        user_not_found: "该邮箱未注册",
      }[data.error] || data.error || "操作失败";
      setAuthError(msg);
      if (authModal === "register") setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) });
    } catch {
      setAuthError("网络错误");
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <>
      <div className="redeem-card glass-card">
        <div className="redeem-card-copy">
          <div className="section-kicker">权益兑换</div>
          <h2>兑换码兑换</h2>
          <p>输入兑换码即可领取余额或专属服务权益</p>
        </div>
        <form className="redeem-card-form" onSubmit={submitRedeem}>
          <div className="redeem-input-wrap">
            <input
              value={redeemInput}
              onChange={(e) => {
                setRedeemInput(normalizeRedeemCode(e.target.value));
                if (redeemStatus?.type === "error") setRedeemStatus(null);
              }}
              placeholder="准确输入兑换码，支持粘贴"
              autoComplete="off"
              inputMode="text"
              aria-label="兑换码"
            />
            <button type="button" className="redeem-paste-btn" onClick={pasteRedeem} disabled={redeemBusy}>
              <Copy size={13} />粘贴
            </button>
          </div>
          <button type="submit" disabled={redeemBusy}>
            {redeemBusy ? <LoaderCircle size={14} className="spin-icon" /> : <Gift size={14} />}
            {redeemBusy ? "处理中" : "立即兑换"}
          </button>
          {redeemStatus && <div className={`redeem-card-status ${redeemStatus.type}`}>{redeemStatus.message}</div>}
        </form>
      </div>

      {authModal && (
        <div className="auth-modal-mask" onClick={() => !authBusy && setAuthModal(null)}>
          <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
            <div className="auth-modal-head">
              {authModal === "login" || authModal === "register" ? (
                <div className="auth-modal-tabs">
                  <button type="button" className={`auth-tab${authModal === "login" ? " active" : ""}`} onClick={() => setAuthModal("login")}>登录</button>
                  <button type="button" className={`auth-tab register-tab${authModal === "register" ? " active" : ""}`} onClick={() => setAuthModal("register")}>
                    注册
                    <span className="auth-tab-tip">立减¥8.88</span>
                  </button>
                </div>
              ) : (
                <div className="auth-modal-title">{authModal === "forgot" ? "找回密码" : "重置密码"}</div>
              )}
              <button type="button" className="auth-close" onClick={() => !authBusy && setAuthModal(null)}>
                <X size={19} />
              </button>
            </div>
            <form className="auth-form" onSubmit={doAuth}>
              <label className="auth-field">
                <span>邮箱</span>
                <input type="email" value={authForm.email} onChange={(e) => setAuthForm((f) => ({ ...f, email: e.target.value }))} placeholder="example@email.com" required />
              </label>
              {(authModal === "login" || authModal === "register") && (
                <label className="auth-field">
                  <span>{authModal === "register" ? "密码 (6-64 位)" : "密码"}</span>
                  <input type="password" value={authForm.password} onChange={(e) => setAuthForm((f) => ({ ...f, password: e.target.value }))} placeholder={authModal === "register" ? "设置一个密码" : "登录密码"} required />
                </label>
              )}
              {authModal === "register" && (
                <label className="auth-field auth-captcha">
                  <span>人机验证</span>
                  <div className="auth-captcha-row">
                    <div className="auth-captcha-question">{authCaptcha.a} + {authCaptcha.b} =</div>
                    <input value={authForm.captchaAnswer} onChange={(e) => setAuthForm((f) => ({ ...f, captchaAnswer: e.target.value }))} placeholder="?" inputMode="numeric" required />
                    <button type="button" className="auth-captcha-refresh" onClick={() => setAuthCaptcha({ a: 1 + Math.floor(Math.random() * 9), b: 1 + Math.floor(Math.random() * 9) })}>
                      <RefreshCw size={15} />
                    </button>
                  </div>
                </label>
              )}
              {authModal === "reset" && (
                <>
                  <label className="auth-field">
                    <span>验证码</span>
                    <input value={authForm.code} onChange={(e) => setAuthForm((f) => ({ ...f, code: e.target.value }))} placeholder="6 位验证码" inputMode="numeric" required />
                  </label>
                  <label className="auth-field">
                    <span>新密码</span>
                    <input type="password" value={authForm.newPassword} onChange={(e) => setAuthForm((f) => ({ ...f, newPassword: e.target.value }))} placeholder="设置新密码" required />
                  </label>
                </>
              )}
              {authNotice && <div className="auth-notice">{authNotice}</div>}
              {authError && <div className="auth-error">{authError}</div>}
              <button type="submit" className="auth-submit" disabled={authBusy}>
                {authBusy ? <><LoaderCircle size={14} className="spin-icon" />处理中</> : authModal === "register" ? "注册并登录" : authModal === "forgot" ? "发送验证码" : authModal === "reset" ? "重置并登录" : "登录"}
              </button>
              {(authModal === "login" || authModal === "register") && (
                <>
                  <div className="auth-divider"><span>或使用</span></div>
                  <div className="oauth-login-grid bottom">
                    <a href="/api/auth/oauth/google/start" className="oauth-login-btn"><GoogleIcon />Google 登录</a>
                  </div>
                </>
              )}
              <div className="auth-hints">
                {authModal === "login" && (
                  <>
                    <button type="button" className="auth-switch" onClick={() => setAuthModal("forgot")}>忘记密码?</button>
                    <span className="auth-hint">还没账号? <button type="button" className="auth-switch" onClick={() => setAuthModal("register")}>立即注册</button></span>
                  </>
                )}
                {authModal === "register" && <span className="auth-hint">已有账号? <button type="button" className="auth-switch" onClick={() => setAuthModal("login")}>去登录</button></span>}
                {authModal === "forgot" && <button type="button" className="auth-switch" onClick={() => setAuthModal("login")}>返回登录</button>}
                {authModal === "reset" && <button type="button" className="auth-switch" onClick={() => setAuthModal("forgot")}>重新发送验证码</button>}
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
