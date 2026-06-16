"use client";

import { useEffect, useState } from "react";
import { Copy, Gift, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useLocale } from "./LocaleProvider";

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

function storedInviteCode() {
  if (typeof window === "undefined") return "";
  try {
    return String(window.localStorage.getItem("lm_invite") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
  } catch (e) {
    return "";
  }
}

function normalizeRedeemCode(value) {
  return String(value || "").replace(/\s+/g, "").replace(/[＿_—–]/g, "-").toUpperCase();
}

export default function RedeemCard({ autoFillFromQuery = false }) {
  const { t, locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const [authUser, setAuthUser] = useState(null);
  const [authModal, setAuthModal] = useState(null);
  const [authForm, setAuthForm] = useState({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
  const [authCaptcha, setAuthCaptcha] = useState({ token: "", image: "", loading: false, error: "" });
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
      setRedeemStatus({ type: "info", message: L("已为您填入兑换码，点击「立即兑换」按钮即可使用", "Code filled in — tap \"Redeem now\" to use it") });
      setTimeout(() => document.getElementById("redeem")?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
    }
  }, [autoFillFromQuery]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.style.overflow = authModal ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [authModal]);

  async function refreshAuthCaptcha(clearAnswer = true) {
    setAuthCaptcha((cur) => ({ ...cur, loading: true, error: "" }));
    if (clearAnswer) setAuthForm((f) => ({ ...f, captchaAnswer: "" }));
    try {
      const res = await fetch("/api/auth/captcha", { credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.token || !data.image) throw new Error(data.message || L("验证码加载失败", "Failed to load captcha"));
      setAuthCaptcha({ token: data.token, image: data.image, loading: false, error: "" });
    } catch {
      setAuthCaptcha({ token: "", image: "", loading: false, error: L("验证码加载失败，请点击刷新", "Couldn't load captcha. Tap to refresh.") });
    }
  }

  useEffect(() => {
    if (authModal === "register") refreshAuthCaptcha(true);
    else setAuthCaptcha({ token: "", image: "", loading: false, error: "" });
    if (!authModal) setAuthForm({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
  }, [authModal]);

  async function pasteRedeem() {
    try {
      const text = await navigator.clipboard?.readText?.();
      const next = normalizeRedeemCode(text);
      if (!next) {
        setRedeemStatus({ type: "error", message: L("剪贴板里没有可用的兑换码", "No usable code on the clipboard") });
        return;
      }
      setRedeemInput(next);
      if (redeemStatus?.type === "error") setRedeemStatus(null);
    } catch {
      setRedeemStatus({ type: "error", message: L("无法读取剪贴板,请长按输入框手动粘贴", "Can't read clipboard — long-press the field to paste manually") });
    }
  }

  async function submitRedeem(event) {
    event.preventDefault();
    const code = redeemInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) {
      setRedeemStatus({ type: "error", message: L("请输入兑换码", "Please enter a code") });
      return;
    }
    setRedeemBusy(true);
    setRedeemStatus({ type: "info", message: L("正在识别兑换码...", "Checking the code...") });
    try {
      const infoRes = await fetch(`/api/redeem-code?code=${encodeURIComponent(code)}`, { cache: "no-store" });
      const info = await infoRes.json();
      if (!infoRes.ok || !info.ok || info.status !== "active") {
        setRedeemStatus({ type: "error", message: info.message || L("兑换码不存在、已使用或已作废", "Code doesn't exist, is used, or is voided") });
        return;
      }
      if (info.type === "service") {
        window.location.href = `/checkout?redeem=${encodeURIComponent(code)}`;
        return;
      }
      if (!authUser || authUser === false) {
        setAuthModal("login");
        setAuthNotice(L("余额兑换码需要先登录账号，登录后再次点击兑换即可到账", "Balance codes require sign-in. Sign in, then tap redeem again to credit your balance."));
        setRedeemStatus({ type: "error", message: L("余额兑换码需要登录账号后兑换", "Please sign in to redeem a balance code") });
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
        setRedeemStatus({ type: "error", message: data.message || L("兑换失败,请联系客服", "Redeem failed, please contact support") });
        return;
      }
      setAuthUser((cur) => cur && cur !== false ? { ...cur, balance: Number(data.balance || cur.balance || 0) } : cur);
      setRedeemInput("");
      setRedeemStatus({ type: "success", message: L(`兑换成功，余额已到账，当前余额 ¥${Number(data.balance || 0).toFixed(2)}`, `Redeemed! Balance updated — current balance ¥${Number(data.balance || 0).toFixed(2)}`) });
    } catch {
      setRedeemStatus({ type: "error", message: L("兑换失败,请稍后再试", "Redeem failed, please try again") });
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
        captchaToken: authCaptcha.token,
        captchaAnswer: authForm.captchaAnswer.trim(),
        inviteCode: storedInviteCode(),
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
        setAuthNotice(L("验证码已发送至邮箱。请查看收件箱(或垃圾邮件)", "A code has been sent to your email. Check your inbox (or spam)."));
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
        captcha_failed: L("验证码错误，请重新输入", "Wrong captcha, please try again"),
        email_taken: L("该邮箱已注册", "This email is already registered"),
        invalid_email: L("邮箱格式错误", "Invalid email format"),
        password_length: L("密码 6-64 位", "Password must be 6-64 characters"),
        invalid_credentials: L("邮箱或密码错误", "Wrong email or password"),
        invalid_code: L("验证码格式错误(6 位数字)", "Invalid code format (6 digits)"),
        code_invalid_or_expired: L("验证码错误或已过期", "Code is wrong or expired"),
        user_not_found: L("该邮箱未注册", "This email isn't registered"),
      }[data.error] || data.error || L("操作失败", "Something went wrong");
      if (authModal === "register" && data.error === "captcha_failed") refreshAuthCaptcha(true);
      setAuthError(msg);
    } catch {
      setAuthError(L("网络错误", "Network error"));
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <>
      <div className="redeem-card glass-card">
        <div className="redeem-card-copy">
          <div className="section-kicker">{t("redeem.kicker")}</div>
          <h2>{t("redeem.title")}</h2>
          <p>{t("redeem.desc")}</p>
        </div>
        <form className="redeem-card-form" onSubmit={submitRedeem}>
          <div className="redeem-input-wrap">
            <input
              value={redeemInput}
              onChange={(e) => {
                setRedeemInput(normalizeRedeemCode(e.target.value));
                if (redeemStatus?.type === "error") setRedeemStatus(null);
              }}
              placeholder={t("redeem.placeholder")}
              autoComplete="off"
              inputMode="text"
              aria-label={t("redeem.title")}
            />
            <button type="button" className="redeem-paste-btn" onClick={pasteRedeem} disabled={redeemBusy}>
              <Copy size={13} />{t("redeem.paste")}
            </button>
          </div>
          <button type="submit" disabled={redeemBusy}>
            {redeemBusy ? <LoaderCircle size={14} className="spin-icon" /> : <Gift size={14} />}
            {redeemBusy ? "..." : t("redeem.submit")}
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
                  <button type="button" className={`auth-tab${authModal === "login" ? " active" : ""}`} onClick={() => setAuthModal("login")}>{L("登录", "Sign in")}</button>
                  <button type="button" className={`auth-tab register-tab${authModal === "register" ? " active" : ""}`} onClick={() => setAuthModal("register")}>
                    {L("注册", "Sign up")}
                    <span className="auth-tab-tip">{L("立减¥8.88", "¥8.88 off")}</span>
                  </button>
                </div>
              ) : (
                <div className="auth-modal-title">{authModal === "forgot" ? L("找回密码", "Reset password") : L("重置密码", "Set new password")}</div>
              )}
              <button type="button" className="auth-close" onClick={() => !authBusy && setAuthModal(null)}>
                <X size={19} />
              </button>
            </div>
            <form className="auth-form" onSubmit={doAuth}>
              <label className="auth-field">
                <span>{L("邮箱", "Email")}</span>
                <input type="email" value={authForm.email} onChange={(e) => setAuthForm((f) => ({ ...f, email: e.target.value }))} placeholder="example@email.com" required />
              </label>
              {(authModal === "login" || authModal === "register") && (
                <label className="auth-field">
                  <span>{authModal === "register" ? L("密码 (6-64 位)", "Password (6-64 chars)") : L("密码", "Password")}</span>
                  <input type="password" value={authForm.password} onChange={(e) => setAuthForm((f) => ({ ...f, password: e.target.value }))} placeholder={authModal === "register" ? L("设置一个密码", "Create a password") : L("登录密码", "Your password")} required />
                </label>
              )}
              {authModal === "register" && (
                <label className="auth-field auth-captcha">
                  <span>{L("验证码", "Captcha")}</span>
                  <div className="auth-captcha-row">
                    <div className="auth-captcha-control">
                      <ShieldCheck size={16} />
                      <input
                        value={authForm.captchaAnswer}
                        onChange={(e) => setAuthForm((f) => ({ ...f, captchaAnswer: e.target.value.replace(/\s+/g, "").slice(0, 4) }))}
                        placeholder={L("验证码", "Captcha")}
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        required
                      />
                    </div>
                    <button type="button" className="auth-captcha-image" onClick={() => refreshAuthCaptcha(true)} disabled={authCaptcha.loading} aria-label={L("刷新验证码", "Refresh captcha")}>
                      {authCaptcha.image && !authCaptcha.loading ? <img src={authCaptcha.image} alt={L("验证码", "Captcha")} /> : <LoaderCircle size={18} className="spin-icon" />}
                      <span><RefreshCw size={12} /></span>
                    </button>
                  </div>
                  {authCaptcha.error && <em className="auth-captcha-error">{authCaptcha.error}</em>}
                </label>
              )}
              {authModal === "reset" && (
                <>
                  <label className="auth-field">
                    <span>{L("验证码", "Code")}</span>
                    <input value={authForm.code} onChange={(e) => setAuthForm((f) => ({ ...f, code: e.target.value }))} placeholder={L("6 位验证码", "6-digit code")} inputMode="numeric" required />
                  </label>
                  <label className="auth-field">
                    <span>{L("新密码", "New password")}</span>
                    <input type="password" value={authForm.newPassword} onChange={(e) => setAuthForm((f) => ({ ...f, newPassword: e.target.value }))} placeholder={L("设置新密码", "Set a new password")} required />
                  </label>
                </>
              )}
              {authNotice && <div className="auth-notice">{authNotice}</div>}
              {authError && <div className="auth-error">{authError}</div>}
              <button type="submit" className="auth-submit" disabled={authBusy || (authModal === "register" && (authCaptcha.loading || !authCaptcha.token))}>
                {authBusy ? <><LoaderCircle size={14} className="spin-icon" />{L("处理中", "Processing")}</> : authModal === "register" ? L("注册并登录", "Sign up & sign in") : authModal === "forgot" ? L("发送验证码", "Send code") : authModal === "reset" ? L("重置并登录", "Reset & sign in") : L("登录", "Sign in")}
              </button>
              {(authModal === "login" || authModal === "register") && (
                <>
                  <div className="auth-divider"><span>{L("或使用", "or use")}</span></div>
                  <div className="oauth-login-grid bottom">
                    <a href="/api/auth/oauth/google/start" className="oauth-login-btn"><GoogleIcon />{L("Google 登录", "Sign in with Google")}</a>
                  </div>
                </>
              )}
              <div className="auth-hints">
                {authModal === "login" && (
                  <>
                    <button type="button" className="auth-switch" onClick={() => setAuthModal("forgot")}>{L("忘记密码?", "Forgot password?")}</button>
                    <span className="auth-hint">{L("还没账号?", "No account?")} <button type="button" className="auth-switch" onClick={() => setAuthModal("register")}>{L("立即注册", "Sign up")}</button></span>
                  </>
                )}
                {authModal === "register" && <span className="auth-hint">{L("已有账号?", "Have an account?")} <button type="button" className="auth-switch" onClick={() => setAuthModal("login")}>{L("去登录", "Sign in")}</button></span>}
                {authModal === "forgot" && <button type="button" className="auth-switch" onClick={() => setAuthModal("login")}>{L("返回登录", "Back to sign in")}</button>}
                {authModal === "reset" && <button type="button" className="auth-switch" onClick={() => setAuthModal("forgot")}>{L("重新发送验证码", "Resend code")}</button>}
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
