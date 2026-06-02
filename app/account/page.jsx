"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import MobileNav from "../components/MobileNav";
import FloatingSupport from "../components/FloatingSupport";
import { DEFAULT_USER_AVATAR_ID, USER_AVATARS, normalizeUserAvatarId, userAvatarPath } from "../lib/avatars";
import {
  ArrowRight, CheckCircle2, Clock, Copy, ExternalLink,
  LoaderCircle, LogOut, Mail, ShoppingBag, X,
  AlertTriangle, Wallet, TrendingDown, TrendingUp,
  User, Users, Edit3, Check,
  Gift, Send, CreditCard, RefreshCw, Share2, BadgePercent, ShieldCheck,
} from "lucide-react";

const STATUS_LABEL = { received: "订单已收到", completed: "订单已完成", invalid: "订单无效·未收到付款" };

function copy(text) {
  if (typeof window === "undefined") return;
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).catch(() => {});
}

function getStoredInviteCode() {
  if (typeof window === "undefined") return "";
  try {
    return String(window.localStorage.getItem("lm_invite") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
  } catch (e) {
    return "";
  }
}

function inviteLink(code) {
  if (!code) return "";
  const origin = typeof window !== "undefined" ? window.location.origin : "https://www.liumeiti.vip";
  return `${origin}/?invite=${encodeURIComponent(code)}`;
}

function maskOrderId(orderId) {
  const value = String(orderId || "").trim().toUpperCase();
  if (!value) return "";
  if (value.length <= 8) return value.replace(/^(.{2}).+(.{2})$/, "$1****$2");
  const start = Math.max(2, Math.floor((value.length - 6) / 2));
  return value.slice(0, start) + "******" + value.slice(start + 6);
}

function displayTxReason(tx) {
  if (tx?.source === "referral" && tx.orderId) {
    return `合伙人收益 ${maskOrderId(tx.orderId)} · ${Number(tx.referralLevel || 1) === 2 ? "二级5%" : "一级10%"}`;
  }
  const reason = String(tx?.reason || "");
  const orderId = String(tx?.orderId || "").trim();
  return orderId ? reason.replace(orderId, maskOrderId(orderId)) : reason;
}

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

export default function AccountPage() {
  const [state, setState] = useState({ loading: true, email: null, username: "", avatarId: DEFAULT_USER_AVATAR_ID, orders: [], balance: 0, txs: [], coupons: [], withdrawals: [], referral: null, referralDownlines: [] });
  const [activeOrder, setActiveOrder] = useState(null);
  const [txModal, setTxModal] = useState(false);
  const [avatarModal, setAvatarModal] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState("");
  const [avatarError, setAvatarError] = useState("");
  const [copiedKey, setCopiedKey] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [moneyForm, setMoneyForm] = useState({
    transferEmail: "", transferAmount: "",
    redeemCode: "",
    withdrawAmount: "", alipayAccount: "", realName: "",
  });
  const [moneyModal, setMoneyModal] = useState(null);
  const [inviteModal, setInviteModal] = useState(false);
  const [downlineModal, setDownlineModal] = useState(false);
  const [activityModal, setActivityModal] = useState(false);
  const [casetifyModal, setCasetifyModal] = useState(false);
  const [moneyBusy, setMoneyBusy] = useState("");
  const [moneyStatus, setMoneyStatus] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ email: "", password: "", captchaAnswer: "", code: "", newPassword: "" });
  const [authCaptcha, setAuthCaptcha] = useState({ token: "", image: "", loading: false, error: "" });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");

  async function load() {
    setState((s) => ({ ...s, loading: true }));
    try {
      const [meRes, balRes] = await Promise.all([
        fetch("/api/auth/me", { credentials: "same-origin" }),
        fetch("/api/auth/balance", { credentials: "same-origin" }),
      ]);
      if (meRes.status === 401) {
        setState({ loading: false, email: null, username: "", avatarId: DEFAULT_USER_AVATAR_ID, orders: [], balance: 0, txs: [], coupons: [], withdrawals: [], referral: null, referralDownlines: [] });
        return;
      }
      const me = await meRes.json();
      const bal = balRes.ok ? await balRes.json() : { balance: 0, transactions: [] };
      if (me.ok) {
        setState({
          loading: false,
          email: me.email,
          username: me.username || "",
          avatarId: normalizeUserAvatarId(me.avatarId),
          orders: me.orders,
          balance: Number(bal.balance || 0),
          txs: bal.transactions || [],
          coupons: bal.coupons || me.coupons || [],
          withdrawals: bal.withdrawals || [],
          referral: me.referral || bal.referral || null,
          referralDownlines: me.referralDownlines || [],
        });
      }
    } catch (e) {
      setState({ loading: false, email: null, username: "", avatarId: DEFAULT_USER_AVATAR_ID, orders: [], balance: 0, txs: [], coupons: [], withdrawals: [], referral: null, referralDownlines: [] });
    }
  }

  useEffect(() => { load(); }, []);

  async function refreshAuthCaptcha(clearAnswer = true) {
    setAuthCaptcha((cur) => ({ ...cur, loading: true, error: "" }));
    if (clearAnswer) setAuthForm((f) => ({ ...f, captchaAnswer: "" }));
    try {
      const res = await fetch("/api/auth/captcha", { credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.token || !data.image) throw new Error(data.message || "验证码加载失败");
      setAuthCaptcha({ token: data.token, image: data.image, loading: false, error: "" });
    } catch (e) {
      setAuthCaptcha({ token: "", image: "", loading: false, error: "验证码加载失败，请点击刷新" });
    }
  }

  useEffect(() => {
    if (authMode === "register") refreshAuthCaptcha(true);
    else setAuthCaptcha({ token: "", image: "", loading: false, error: "" });
  }, [authMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("auth");
    if (status === "register") setAuthMode("register");
    if (status === "oauth_new") setAuthNotice("注册成功,新用户 ¥8.88 优惠券已发放,结算时自动抵扣");
    if (status === "oauth_ok") setAuthNotice("Google 登录成功");
    const oauthErrorMap = {
      google_not_configured: "第三方登录暂不可用,请先使用邮箱登录或注册",
      invalid_oauth_state: "Google 登录状态已失效，请重新点击 Google 登录",
      invalid_client: "Google Client ID 或 Client Secret 不匹配，请检查 Vercel 环境变量和 Google Cloud OAuth 客户端",
      redirect_uri_mismatch: "Google 回调地址不匹配，请在 Google Cloud 中添加 https://www.liumeiti.vip/api/auth/oauth/google/callback",
      access_denied: "你取消了 Google 授权",
      oauth_failed: "Google 登录失败，请稍后重试或使用邮箱登录",
      email_not_verified: "Google 邮箱未验证，暂时无法登录",
    };
    if (oauthErrorMap[status]) {
      setAuthMode("login");
      setAuthError(oauthErrorMap[status]);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const openActivityFromHash = () => {
      if (window.location.hash !== "#casetify-reward") return;
      setCasetifyModal(true);
      window.setTimeout(() => {
        document.getElementById("casetify-reward")?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 80);
    };
    openActivityFromHash();
    window.addEventListener("hashchange", openActivityFromHash);
    return () => window.removeEventListener("hashchange", openActivityFromHash);
  }, []);

  async function logout() {
    await fetch("/api/auth/login", { method: "DELETE" });
    window.location.href = "/";
  }

  async function doAuth(e) {
    e.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      let payload = {};
      if (authMode === "login") payload = { email: authForm.email.trim(), password: authForm.password };
      if (authMode === "register") payload = {
        email: authForm.email.trim(),
        password: authForm.password,
        captchaToken: authCaptcha.token,
        captchaAnswer: authForm.captchaAnswer.trim(),
        inviteCode: getStoredInviteCode(),
      };
      if (authMode === "forgot") payload = { email: authForm.email.trim() };
      if (authMode === "reset") payload = {
        email: authForm.email.trim(),
        code: authForm.code.trim(),
        newPassword: authForm.newPassword,
      };
      const res = await fetch(`/api/auth/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (authMode === "forgot") {
        setAuthNotice("验证码已发送至邮箱。请查看收件箱(或垃圾邮件)");
        setAuthMode("reset");
        setAuthForm((f) => ({ ...f, code: "", newPassword: "" }));
        return;
      }
      if (data.ok) {
        await load();
        return;
      }
      const msg = {
        captcha_failed: "验证码错误，请重新输入",
        email_taken: "该邮箱已注册",
        invalid_email: "邮箱格式错误",
        password_length: "密码 6-64 位",
        invalid_credentials: "邮箱或密码错误",
        invalid_code: "验证码格式错误(6 位数字)",
        code_invalid_or_expired: "验证码错误或已过期",
        user_not_found: "该邮箱未注册",
      }[data.error] || data.error || "操作失败";
      if (authMode === "register" && data.error === "captcha_failed") refreshAuthCaptcha(true);
      setAuthError(msg);
    } catch (error) {
      setAuthError("网络错误");
    } finally {
      setAuthBusy(false);
    }
  }

  function handleCopy(text, key) {
    copy(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(""), 1800);
  }

  function renderCasetifyActivityCard() {
    return (
      <button
        id="casetify-reward"
        type="button"
        className="account-invite-poster account-casetify-poster"
        onClick={() => setCasetifyModal(true)}
      >
        <div className="account-invite-poster-icon account-casetify-poster-icon"><Gift size={20} /></div>
        <div>
          <span>Maoyang X CASETiFY · 至 2026.12.31</span>
          <strong>消费充值送 CASETiFY 手机壳</strong>
          <p>注册用户消费满 ¥999，或单次充值 ¥1666，可联系客服领取</p>
        </div>
      </button>
    );
  }

  function renderCasetifyActivityModal() {
    if (!casetifyModal) return null;
    return (
      <div className="account-modal-mask" onClick={() => setCasetifyModal(false)}>
        <div className="account-money-modal account-invite-modal account-casetify-modal" onClick={(e) => e.stopPropagation()}>
          <div className="account-modal-head">
            <div>
              <div className="account-modal-id">Maoyang X CASETiFY</div>
              <div className="account-modal-status status-completed">活动至 2026.12.31</div>
            </div>
            <button type="button" className="account-modal-close" onClick={() => setCasetifyModal(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="account-invite-modal-body">
            <div className="account-invite-hero account-casetify-hero">
              <span><Gift size={15} />注册用户专享奖励</span>
              <strong>消费充值送 CASETiFY 手机壳</strong>
              <p>注册用户累计消费满 ¥999，或单次充值 ¥1666，可联系在线客服领取 CASETiFY 官网在售任意手机壳 1 个，支持定制款</p>
            </div>
            <div className="account-casetify-intro">
              <strong>关于 CASETiFY 手机壳</strong>
              <p>CASETiFY 手机壳主打防摔保护、丰富联名与个性化定制，适合想兼顾日常保护和外观风格的用户，奖品由 CASETiFY 官方发出，并在发出后提供包囊跟踪编号</p>
            </div>
            <div className="account-invite-rule-list account-casetify-rule-list">
              <div>
                <b>领取条件</b>
                <p>活动有效期至 2026 年 12 月 31 日，注册用户累计消费满 ¥999，或单次充值 ¥1666，即可联系客服免费领取</p>
              </div>
              <div>
                <b>可选款式</b>
                <p>支持 CASETiFY 官网在售任意手机壳款式，包含可定制款，具体机型与库存以官网展示为准</p>
              </div>
              <div>
                <b>收货范围</b>
                <p>本活动暂不支持中国大陆地址收货，请确认可提供支持配送的收货地址，活动奖品不支持折现</p>
              </div>
              <div>
                <b>领取说明</b>
                <p>领取奖品后，对应充值金额仅可用于本站消费，不支持退款与提现，确认领取即视为认可活动说明</p>
              </div>
            </div>
            <div className="account-casetify-actions">
              <a href="https://www.casetify.com/" target="_blank" rel="noreferrer">
                <ExternalLink size={14} />查看有什么款式
              </a>
              <Link href="/service-center#contact" onClick={() => setCasetifyModal(false)}>
                <Send size={14} />联系在线客服
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function startEditName() {
    setNameDraft(state.username || "");
    setNameError("");
    setEditingName(true);
  }

  async function saveName() {
    if (nameSaving) return;
    setNameSaving(true);
    setNameError("");
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: nameDraft.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setState((s) => ({ ...s, username: data.username }));
        setEditingName(false);
      } else {
        setNameError(data.message || "用户名格式无效");
      }
    } catch (e) {
      setNameError("网络错误");
    } finally {
      setNameSaving(false);
    }
  }

  function updateMoneyField(field, value) {
    setMoneyForm((cur) => ({ ...cur, [field]: value }));
    if (moneyStatus?.type === "error") setMoneyStatus(null);
  }

  async function submitMoneyAction(action, endpoint, payload, resetFields = []) {
    if (moneyBusy) return;
    setMoneyBusy(action);
    setMoneyStatus(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || data.error || "操作失败");
      setMoneyStatus({ type: "success", message: data.message || "操作成功" });
      setMoneyForm((cur) => {
        const next = { ...cur };
        resetFields.forEach((k) => { next[k] = ""; });
        return next;
      });
      setMoneyModal(null);
      await load();
    } catch (e) {
      setMoneyStatus({ type: "error", message: e.message || "操作失败,请稍后再试" });
    } finally {
      setMoneyBusy("");
    }
  }

  if (state.loading) {
    return <div className="account-loading"><LoaderCircle size={28} className="spin-icon" /></div>;
  }

  if (!state.email) {
    return (
      <div className="account-page account-auth-page">
        <header className="account-header">
          <Link href="/" className="account-brand-only" aria-label="冒央会社首页">
            <img src="/logo.png" alt="冒央会社" className="account-logo" />
          </Link>
        </header>
        <main className="account-main">
          <button type="button" className="account-invite-poster" onClick={() => setActivityModal(true)}>
            <div className="account-invite-poster-icon"><BadgePercent size={20} /></div>
            <div>
              <span>合伙人计划</span>
              <strong>注册即可获得专属邀请链接</strong>
              <p>分享稳定好用的流媒体服务，一次推荐可持续获得长期收益</p>
            </div>
          </button>
          {renderCasetifyActivityCard()}
          <section className="auth-modal account-auth-card">
            <div className="auth-modal-head">
              {authMode === "login" || authMode === "register" ? (
                <div className="auth-modal-tabs">
                  <button type="button" className={`auth-tab${authMode === "login" ? " active" : ""}`} onClick={() => setAuthMode("login")}>登录</button>
                  <button type="button" className={`auth-tab register-tab${authMode === "register" ? " active" : ""}`} onClick={() => setAuthMode("register")}>
                    注册
                    <span className="auth-tab-tip">立减¥8.88</span>
                  </button>
                </div>
              ) : (
                <div className="auth-modal-title">{authMode === "forgot" ? "找回密码" : "重置密码"}</div>
              )}
            </div>
            <form className="auth-form" onSubmit={doAuth}>
              <label className="auth-field">
                <span>邮箱</span>
                <input type="email" value={authForm.email} onChange={(e) => setAuthForm((f) => ({ ...f, email: e.target.value }))} placeholder="example@email.com" required />
              </label>
              {(authMode === "login" || authMode === "register") && (
                <label className="auth-field">
                  <span>{authMode === "register" ? "密码 (6-64 位)" : "密码"}</span>
                  <input type="password" value={authForm.password} onChange={(e) => setAuthForm((f) => ({ ...f, password: e.target.value }))} placeholder={authMode === "register" ? "设置一个密码" : "登录密码"} required />
                </label>
              )}
              {authMode === "register" && (
                <label className="auth-field auth-captcha">
                  <span>验证码</span>
                  <div className="auth-captcha-row">
                    <div className="auth-captcha-control">
                      <ShieldCheck size={16} />
                      <input
                        value={authForm.captchaAnswer}
                        onChange={(e) => setAuthForm((f) => ({ ...f, captchaAnswer: e.target.value.replace(/\s+/g, "").slice(0, 4) }))}
                        placeholder="验证码"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        required
                      />
                    </div>
                    <button type="button" className="auth-captcha-image" onClick={() => refreshAuthCaptcha(true)} disabled={authCaptcha.loading} aria-label="刷新验证码">
                      {authCaptcha.image && !authCaptcha.loading ? <img src={authCaptcha.image} alt="验证码" /> : <LoaderCircle size={18} className="spin-icon" />}
                      <span><RefreshCw size={12} /></span>
                    </button>
                  </div>
                  {authCaptcha.error && <em className="auth-captcha-error">{authCaptcha.error}</em>}
                </label>
              )}
              {authMode === "reset" && (
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
              <button type="submit" className="auth-submit" disabled={authBusy || (authMode === "register" && (authCaptcha.loading || !authCaptcha.token))}>
                {authBusy ? <><LoaderCircle size={14} className="spin-icon" />处理中</> : authMode === "register" ? "注册并登录" : authMode === "forgot" ? "发送验证码" : authMode === "reset" ? "重置并登录" : "登录"}
              </button>
              {(authMode === "login" || authMode === "register") && (
                <>
                  <div className="auth-divider"><span>或使用</span></div>
                  <div className="oauth-login-grid bottom">
                    <a href="/api/auth/oauth/google/start" className="oauth-login-btn"><GoogleIcon />Google 登录</a>
                  </div>
                </>
              )}
              <div className="auth-hints">
                {authMode === "login" && (
                  <>
                    <button type="button" className="auth-switch" onClick={() => setAuthMode("forgot")}>忘记密码?</button>
                    <span className="auth-hint">还没账号? <button type="button" className="auth-switch" onClick={() => setAuthMode("register")}>立即注册</button></span>
                  </>
                )}
                {authMode === "register" && <span className="auth-hint">已有账号? <button type="button" className="auth-switch" onClick={() => setAuthMode("login")}>去登录</button></span>}
                {authMode === "forgot" && <button type="button" className="auth-switch" onClick={() => setAuthMode("login")}>返回登录</button>}
                {authMode === "reset" && <button type="button" className="auth-switch" onClick={() => setAuthMode("forgot")}>重新发送验证码</button>}
              </div>
            </form>
          </section>
        </main>
        {activityModal && (
          <div className="account-modal-mask" onClick={() => setActivityModal(false)}>
            <div className="account-money-modal account-activity-modal" onClick={(e) => e.stopPropagation()}>
              <div className="account-modal-head">
                <div>
                  <div className="account-modal-id">合伙人计划</div>
                  <div className="account-modal-status status-completed">最高 15% 佣金</div>
                </div>
                <button type="button" className="account-modal-close" onClick={() => setActivityModal(false)}>
                  <X size={16} />
                </button>
              </div>
              <div className="account-invite-modal-body">
                <div className="account-invite-hero">
                  <span><BadgePercent size={15} />注册即可获得专属邀请链接</span>
                  <strong>优质服务更好推广，一次分享长期收益</strong>
                  <p>把高性价比会员与稳定售后分享给朋友或社群，好友完成有效订单后，收益会自动计入账户余额</p>
                </div>
                <div className="account-invite-rule-list">
                  <div><b>服务好推广</b><p>主流会员、节点服务与售后协助一站完成，朋友更容易理解也更愿意复购</p></div>
                  <div><b>分享成交收益</b><p>好友通过你的链接下单并完成服务后，你可获得实付金额 10% 佣金</p></div>
                  <div><b>长期客户收益</b><p>好友通过你的链接注册后，会成为你的一级用户，后续有效订单也会持续带来 10% 收益</p></div>
                  <div><b>团队扩散奖励</b><p>一级用户继续邀请新用户后，你也可获得二级用户有效订单 5% 奖励，分享越久积累越多</p></div>
                </div>
              </div>
            </div>
          </div>
        )}
        {renderCasetifyActivityModal()}
        <FloatingSupport />
        <MobileNav />
      </div>
    );
  }

  async function saveAvatar(avatarId) {
    if (avatarSaving) return;
    setAvatarSaving(avatarId);
    setAvatarError("");
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || "头像保存失败");
      setState((s) => ({ ...s, avatarId: normalizeUserAvatarId(data.avatarId || avatarId) }));
      setAvatarModal(false);
    } catch (e) {
      setAvatarError(e.message || "头像保存失败，请稍后再试");
    } finally {
      setAvatarSaving("");
    }
  }

  const activeCoupon = state.coupons.find((c) => c.status === "active");

  return (
    <div className="account-page">
      <header className="account-header">
        <Link href="/" className="account-brand-only" aria-label="冒央会社首页">
          <img src="/logo.png" alt="冒央会社" className="account-logo" />
        </Link>
        <button type="button" className="account-logout" onClick={logout}>
          <LogOut size={13} />退出
        </button>
      </header>

      <main className="account-main">
        <section className="account-info-card">
          <button type="button" className="account-avatar" onClick={() => setAvatarModal(true)} aria-label="更换头像">
            <img src={userAvatarPath(state.avatarId)} alt="" className="account-avatar-img" />
            <span className="account-avatar-edit"><Edit3 size={10} /></span>
          </button>
          <div className="account-info-text">
            {editingName ? (
              <div className="account-name-edit">
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="2-20 位 中/英/数字/_"
                  maxLength={20}
                  autoFocus
                />
                <button type="button" onClick={saveName} disabled={nameSaving} className="account-name-save">
                  {nameSaving ? <LoaderCircle size={12} className="spin-icon" /> : <Check size={12} />}
                </button>
                <button type="button" onClick={() => setEditingName(false)} disabled={nameSaving} className="account-name-cancel"><X size={12} /></button>
              </div>
            ) : (
              <div className="account-username">
                <User size={12} />
                <strong>{state.username || "未设置"}</strong>
                <button type="button" className="account-name-edit-btn" onClick={startEditName} aria-label="修改用户名"><Edit3 size={11} /></button>
              </div>
            )}
            {nameError && <div className="account-name-error">{nameError}</div>}
            <div className="account-info-email">
              <Mail size={11} />
              <span>{state.email}</span>
            </div>
          </div>
        </section>

        <section className="account-balance-card">
          <div className="account-balance-row">
            <div className="account-balance-label">
              <Wallet size={14} />
              账户余额
            </div>
            <div className="account-balance-value">¥{state.balance.toFixed(2)}</div>
          </div>
          <button
            type="button"
            className="account-balance-toggle"
            onClick={() => setTxModal(true)}
          >
            查看余额明细 · {state.txs.length} 笔
          </button>
        </section>

        <section className="account-money-tools">
          {moneyStatus && <div className={`account-tool-alert ${moneyStatus.type}`}>{moneyStatus.message}</div>}
          <div className="account-tool-buttons">
            <button type="button" onClick={() => setMoneyModal("transfer")}><Send size={13} />转账</button>
            <button type="button" onClick={() => setMoneyModal("withdraw")}><CreditCard size={13} />提现</button>
            <button type="button" onClick={() => setDownlineModal(true)}><Users size={13} />下级</button>
            <button type="button" onClick={() => setInviteModal(true)}><Share2 size={13} />邀请</button>
          </div>

          <div className="account-coupon-strip">
            <Gift size={13} />
            <strong>{activeCoupon ? `可用优惠券 ¥${Number(activeCoupon.amount || 0).toFixed(2)}` : "暂无可用优惠券"}</strong>
            <span>付款自动抵扣</span>
          </div>

          <form
            className="account-tool-card"
            onSubmit={(e) => {
              e.preventDefault();
              submitMoneyAction("transfer", "/api/auth/transfer", {
                email: moneyForm.transferEmail,
                amount: moneyForm.transferAmount,
              }, ["transferEmail", "transferAmount"]);
            }}
          >
            <div className="account-tool-head"><Send size={14} />邮箱转账</div>
            <label className="account-tool-field">
              <span>收款邮箱</span>
              <input value={moneyForm.transferEmail} onChange={(e) => updateMoneyField("transferEmail", e.target.value)} placeholder="对方注册邮箱" inputMode="email" required />
            </label>
            <label className="account-tool-field">
              <span>转账金额</span>
              <input value={moneyForm.transferAmount} onChange={(e) => updateMoneyField("transferAmount", e.target.value)} placeholder="0.00" inputMode="decimal" required />
            </label>
            <button type="submit" disabled={moneyBusy === "transfer"}>{moneyBusy === "transfer" ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}确认转账</button>
          </form>

          <form
            className="account-tool-card"
            onSubmit={(e) => {
              e.preventDefault();
              submitMoneyAction("redeem", "/api/auth/redeem", {
                code: moneyForm.redeemCode,
              }, ["redeemCode"]);
            }}
          >
            <div className="account-tool-head"><Gift size={14} />余额兑换码</div>
            <label className="account-tool-field full">
              <span>兑换码</span>
              <input value={moneyForm.redeemCode} onChange={(e) => updateMoneyField("redeemCode", e.target.value.toUpperCase())} placeholder="输入余额兑换码" autoComplete="off" required />
            </label>
            <button type="submit" disabled={moneyBusy === "redeem"}>{moneyBusy === "redeem" ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}立即兑换</button>
          </form>

          <form
            className="account-tool-card withdraw"
            onSubmit={(e) => {
              e.preventDefault();
              submitMoneyAction("withdraw", "/api/auth/withdraw", {
                amount: moneyForm.withdrawAmount,
                alipayAccount: moneyForm.alipayAccount,
                realName: moneyForm.realName,
              }, ["withdrawAmount", "alipayAccount", "realName"]);
            }}
          >
            <div className="account-tool-head"><CreditCard size={14} />余额提现</div>
            <label className="account-tool-field">
              <span>提现金额</span>
              <input value={moneyForm.withdrawAmount} onChange={(e) => updateMoneyField("withdrawAmount", e.target.value)} placeholder="0.00" inputMode="decimal" required />
            </label>
            <label className="account-tool-field">
              <span>姓名</span>
              <input value={moneyForm.realName} onChange={(e) => updateMoneyField("realName", e.target.value)} placeholder="支付宝实名" autoComplete="name" required />
            </label>
            <label className="account-tool-field full">
              <span>支付宝账号</span>
              <input value={moneyForm.alipayAccount} onChange={(e) => updateMoneyField("alipayAccount", e.target.value)} placeholder="手机号 / 邮箱 / 支付宝账号" required />
            </label>
            <button type="submit" disabled={moneyBusy === "withdraw"}>{moneyBusy === "withdraw" ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}确认提现</button>
          </form>
        </section>

        {renderCasetifyActivityCard()}

        <section className="account-orders">
          <div className="account-orders-head">
            <div>
              <div className="section-kicker">我的订单</div>
              <h2>我的订单</h2>
            </div>
            <span className="account-orders-count">{state.orders.length} 笔</span>
          </div>

          {state.orders.length === 0 ? (
            <div className="account-empty">
              <ShoppingBag size={36} />
              <p>暂无订单</p>
              <Link href="/shop" className="account-empty-cta">前往选购</Link>
            </div>
          ) : (
            <div className="account-orders-list">
              {state.orders.map((o) => (
                <button
                  key={o.orderId}
                  type="button"
                  className={`account-order-card status-${o.status}`}
                  onClick={() => setActiveOrder(o)}
                >
                  <div className="account-order-top">
                    <span className="account-order-id">{o.orderId}</span>
                    <span className={`account-order-status status-${o.status}`}>
                      {o.status === "completed" ? <CheckCircle2 size={11} /> : o.status === "invalid" ? <AlertTriangle size={11} /> : <Clock size={11} />}
                      {STATUS_LABEL[o.status]}
                    </span>
                  </div>
                  <div className="account-order-mid">
                    <span>{o.serviceLabel}</span>
                    {o.itemCount > 1 && <em>{o.itemCount} 件</em>}
                  </div>
                  <div className="account-order-bot">
                    <span>{o.paidCurrency === "CODE" ? "兑换码" : o.paidCurrency === "USDT" ? `${o.paidAmount} USDT` : `¥${o.paidAmount}`}</span>
                    <small>{o.createdAtBeijing?.split(" ")[0] || ""}</small>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>

      {moneyModal && (
        <div className="account-modal-mask" onClick={() => !moneyBusy && setMoneyModal(null)}>
          <div className="account-money-modal" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-head">
              <div>
                <div className="account-modal-id">
                  {moneyModal === "transfer" ? "邮箱转账" : moneyModal === "redeem" ? "余额兑换码" : "余额提现"}
                </div>
                <div className="account-modal-status status-received">当前余额 ¥{state.balance.toFixed(2)}</div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setMoneyModal(null)} disabled={!!moneyBusy}>
                <X size={16} />
              </button>
            </div>
            <form
              className="account-money-modal-body"
              onSubmit={(e) => {
                e.preventDefault();
                if (moneyModal === "transfer") {
                  submitMoneyAction("transfer", "/api/auth/transfer", {
                    email: moneyForm.transferEmail,
                    amount: moneyForm.transferAmount,
                  }, ["transferEmail", "transferAmount"]);
                } else if (moneyModal === "redeem") {
                  submitMoneyAction("redeem", "/api/auth/redeem", {
                    code: moneyForm.redeemCode,
                  }, ["redeemCode"]);
                } else {
                  submitMoneyAction("withdraw", "/api/auth/withdraw", {
                    amount: moneyForm.withdrawAmount,
                    alipayAccount: moneyForm.alipayAccount,
                    realName: moneyForm.realName,
                  }, ["withdrawAmount", "alipayAccount", "realName"]);
                }
              }}
            >
              {moneyModal === "transfer" && (
                <>
                  <label className="account-tool-field full"><span>收款邮箱</span><input value={moneyForm.transferEmail} onChange={(e) => updateMoneyField("transferEmail", e.target.value)} placeholder="对方注册邮箱" inputMode="email" required /></label>
                  <label className="account-tool-field full"><span>转账金额</span><input value={moneyForm.transferAmount} onChange={(e) => updateMoneyField("transferAmount", e.target.value)} placeholder="0.00" inputMode="decimal" required /></label>
                </>
              )}
              {moneyModal === "redeem" && (
                <label className="account-tool-field full"><span>兑换码</span><input value={moneyForm.redeemCode} onChange={(e) => updateMoneyField("redeemCode", e.target.value.toUpperCase())} placeholder="输入余额兑换码" autoComplete="off" required /></label>
              )}
              {moneyModal === "withdraw" && (
                <>
                  <label className="account-tool-field"><span>提现金额</span><input value={moneyForm.withdrawAmount} onChange={(e) => updateMoneyField("withdrawAmount", e.target.value)} placeholder="0.00" inputMode="decimal" required /></label>
                  <label className="account-tool-field"><span>姓名</span><input value={moneyForm.realName} onChange={(e) => updateMoneyField("realName", e.target.value)} placeholder="支付宝实名" autoComplete="name" required /></label>
                  <label className="account-tool-field full"><span>支付宝账号</span><input value={moneyForm.alipayAccount} onChange={(e) => updateMoneyField("alipayAccount", e.target.value)} placeholder="手机号 / 邮箱 / 支付宝账号" required /></label>
                </>
              )}
              {moneyStatus && <div className={`account-tool-alert ${moneyStatus.type}`}>{moneyStatus.message}</div>}
              <button type="submit" disabled={!!moneyBusy} className="account-money-submit">
                {moneyBusy ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}
                {moneyBusy ? "处理中" : moneyModal === "withdraw" ? "确认提现" : "确认提交"}
              </button>
            </form>
          </div>
        </div>
      )}

      {txModal && (
        <div className="account-modal-mask" onClick={() => setTxModal(false)}>
          <div className="account-money-modal account-tx-modal" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-head">
              <div>
                <div className="account-modal-id">余额明细</div>
                <div className="account-modal-status status-received">当前余额 ¥{state.balance.toFixed(2)}</div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setTxModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="account-tx-modal-body">
              <div className="account-tx-list">
                {state.txs.length === 0 ? (
                  <div className="account-tx-empty">暂无余额变动记录</div>
                ) : (
                  state.txs.map((tx) => (
                    <div key={tx.id} className={`account-tx-item${tx.amount > 0 ? " positive" : " negative"}`}>
                      <div className="account-tx-icon">
                        {tx.amount > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                      </div>
                      <div className="account-tx-info">
                        <strong>{displayTxReason(tx)}</strong>
                        <small>{tx.createdAtBeijing}{tx.statusLabel ? ` · ${tx.statusLabel}` : ""}</small>
                      </div>
                      <div className="account-tx-amount">
                        {tx.amount > 0 ? "+" : ""}¥{Math.abs(tx.amount).toFixed(2)}
                      </div>
                    </div>
                  ))
                )}
                <div className="account-tx-note">
                  <AlertTriangle size={11} />
                  余额仅用于网站会员服务下单时结算,如需充值请联系客服
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {avatarModal && (
        <div className="account-modal-mask" onClick={() => !avatarSaving && setAvatarModal(false)}>
          <div className="account-money-modal account-avatar-modal" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-head">
              <div>
                <div className="account-modal-id">更换头像</div>
                <div className="account-modal-status status-received">选择一个卡通头像</div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setAvatarModal(false)} disabled={!!avatarSaving}>
                <X size={16} />
              </button>
            </div>
            <div className="account-avatar-modal-body">
              <div className="account-avatar-grid">
                {USER_AVATARS.map((avatar) => {
                  const active = normalizeUserAvatarId(state.avatarId) === avatar.id;
                  return (
                    <button
                      key={avatar.id}
                      type="button"
                      className={`account-avatar-choice${active ? " active" : ""}`}
                      onClick={() => (active ? setAvatarModal(false) : saveAvatar(avatar.id))}
                      disabled={!!avatarSaving}
                    >
                      <img src={userAvatarPath(avatar.id)} alt="" />
                      <span>{avatar.label}</span>
                      {active && <em><Check size={11} />当前</em>}
                      {avatarSaving === avatar.id && <em><LoaderCircle size={11} className="spin-icon" />保存中</em>}
                    </button>
                  );
                })}
              </div>
              {avatarError && <div className="account-tool-alert error">{avatarError}</div>}
            </div>
          </div>
        </div>
      )}

      {downlineModal && (
        <div className="account-modal-mask" onClick={() => setDownlineModal(false)}>
          <div className="account-money-modal account-downline-modal" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-head">
              <div>
                <div className="account-modal-id">我的下级</div>
                <div className="account-modal-status status-received">{state.referralDownlines.length} 位邀请用户</div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setDownlineModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="account-downline-list">
              {state.referralDownlines.length === 0 ? (
                <div className="account-downline-empty">
                  <Users size={18} />
                  <strong>暂无下级用户</strong>
                  <span>复制邀请链接分享给好友，好友注册或下单后会在这里显示</span>
                </div>
              ) : (
                state.referralDownlines.map((item, index) => (
                  <div key={`${item.email}-${index}`} className="account-downline-item">
                    <div>
                      <strong>{item.email}</strong>
                      {item.joinedAtBeijing && <small>{item.joinedAtBeijing}</small>}
                    </div>
                    <em>{item.levelLabel}</em>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {inviteModal && (
        <div className="account-modal-mask" onClick={() => setInviteModal(false)}>
          <div className="account-money-modal account-invite-modal" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-head">
              <div>
                <div className="account-modal-id">合伙人计划</div>
                <div className="account-modal-status status-completed">最高 15% 佣金</div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setInviteModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="account-invite-modal-body">
              <div className="account-invite-hero">
                <span><BadgePercent size={15} />专属邀请链接</span>
                <strong>一次分享，长期收益</strong>
                <p>把稳定好用的流媒体服务分享出去，有效订单完成后，合伙人收益会自动计入账户余额</p>
              </div>
              <div className="account-invite-link-box">
                <span>你的邀请链接</span>
                <code>{inviteLink(state.referral?.inviteCode || "") || "正在生成专属链接"}</code>
                <button
                  type="button"
                  disabled={!state.referral?.inviteCode}
                  onClick={() => handleCopy(inviteLink(state.referral?.inviteCode || ""), "invite-link")}
                >
                  {copiedKey === "invite-link" ? "已复制" : <><Copy size={13} />复制链接</>}
                </button>
              </div>
              <div className="account-invite-rule-list">
                <div>
                  <b>直接分享成交</b>
                  <p>他人通过你的专属链接进入网站并完成有效订单后，你获得订单实付金额 10% 佣金</p>
                </div>
                <div>
                  <b>一级用户长期绑定</b>
                  <p>他人通过你的链接注册账号后，会成为你的一级用户；该用户以后每次有效订单完成后，你都获得 10% 佣金</p>
                </div>
                <div>
                  <b>二级用户奖励</b>
                  <p>你的一级用户继续邀请新用户注册或下单，该新用户属于你的二级用户；有效订单完成后，你可获得 5% 二级佣金</p>
                </div>
                <div>
                  <b>收益规则</b>
                  <p>收益仅在有效订单完成后发放，未付款、异常订单、兑换码免支付订单不会产生有效佣金</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {renderCasetifyActivityModal()}

      {activeOrder && (
        <div className="account-modal-mask" onClick={() => setActiveOrder(null)}>
          <div className="account-modal" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-head">
              <div>
                <div className="account-modal-id">{activeOrder.orderId}</div>
                <div className={`account-modal-status status-${activeOrder.status}`}>
                  {activeOrder.status === "completed" ? <CheckCircle2 size={12} /> : activeOrder.status === "invalid" ? <AlertTriangle size={12} /> : <Clock size={12} />}
                  {STATUS_LABEL[activeOrder.status]}
                </div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setActiveOrder(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="account-modal-body">
              <div className="account-modal-amount">
                <span>实付金额</span>
                <b>{activeOrder.paidCurrency === "CODE" ? "服务兑换码" : activeOrder.paidCurrency === "USDT" ? `${activeOrder.paidAmount} USDT` : `¥${activeOrder.paidAmount}`}</b>
                <em>{activeOrder.paymentMethod === "redeem" ? "兑换码" : activeOrder.paymentMethod === "usdt" ? "USDT" : "支付宝"}</em>
              </div>

              <div className="account-modal-items-label">商品明细 · {activeOrder.itemCount} 件</div>
              <div className="account-modal-items">
                {activeOrder.items.map((it, idx) => (
                  <div key={idx} className="account-modal-item">
                    <div className="account-modal-item-head">
                      <strong>{it.label}</strong>
                      <span>{it.cycle} · ¥{it.amount}</span>
                    </div>
                    {(it.account || it.password) && (
                      <div className="account-modal-creds">
                        {it.account && (
                          <div>
                            <span>{it.service === "rocket" ? "用户名" : "账号"}</span>
                            <code>{it.account}</code>
                            <button type="button" onClick={() => handleCopy(it.account, `acc-${idx}`)}>
                              {copiedKey === `acc-${idx}` ? "已复制" : <Copy size={11} />}
                            </button>
                          </div>
                        )}
                        {it.password && (
                          <div>
                            <span>密码</span>
                            <code>{it.password}</code>
                            <button type="button" onClick={() => handleCopy(it.password, `pwd-${idx}`)}>
                              {copiedKey === `pwd-${idx}` ? "已复制" : <Copy size={11} />}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {it.subscriptionLinks && (
                      <div className="account-modal-subs">
                        <button type="button" onClick={() => handleCopy(it.subscriptionLinks.shadowrocket, `sr-${idx}`)}>
                          <div>
                            <strong>Shadowrocket 订阅</strong>
                            <small>{it.subscriptionLinks.shadowrocket}</small>
                          </div>
                          <em>{copiedKey === `sr-${idx}` ? "已复制" : "复制"}</em>
                        </button>
                        <button type="button" onClick={() => handleCopy(it.subscriptionLinks.clash, `cl-${idx}`)}>
                          <div>
                            <strong>Clash 订阅</strong>
                            <small>{it.subscriptionLinks.clash}</small>
                          </div>
                          <em>{copiedKey === `cl-${idx}` ? "已复制" : "复制"}</em>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {activeOrder.staffNotes && (
                <div className="account-modal-staff-notes">
                  <div className="account-modal-staff-notes-label">客服备注</div>
                  <div>{activeOrder.staffNotes}</div>
                </div>
              )}

              <div className="account-modal-meta">
                <div><span>下单时间</span><b>{activeOrder.createdAtBeijing}</b></div>
                {activeOrder.completedAtBeijing && (
                  <div><span>完成时间</span><b>{activeOrder.completedAtBeijing}</b></div>
                )}
                <div><span>联系方式</span><b>{activeOrder.contact}</b></div>
                {activeOrder.remark && (
                  <div><span>下单备注</span><b>{activeOrder.remark}</b></div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <FloatingSupport />
      <MobileNav />
    </div>
  );
}
