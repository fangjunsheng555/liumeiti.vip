"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import MobileNav from "../components/MobileNav";
import FloatingSupport from "../components/FloatingSupport";
import AfterSalesTicketSheet from "../components/AfterSalesTicketSheet";
import { useLocale } from "../components/LocaleProvider";
import { DEFAULT_USER_AVATAR_ID, USER_AVATARS, normalizeUserAvatarId, userAvatarPath } from "../lib/avatars";
import {
  ArrowRight, CheckCircle2, Clock, Copy, ExternalLink,
  LoaderCircle, LogOut, Mail, ShoppingBag, X,
  AlertTriangle, Wallet, TrendingDown, TrendingUp,
  User, Users, Edit3, Check,
  Gift, Send, CreditCard, RefreshCw, Share2, BadgePercent, ShieldCheck,
  LifeBuoy,
} from "lucide-react";

const INVITE_LINK_ORIGIN = "https://www.liumeiti.vip";
const GOOGLE_OAUTH_START = "/api/auth/oauth/google/start";

const STATUS_LABEL = { awaiting_quote: "等待人工报价", pending_payment: "等待付款", received: "订单已收到", completed: "订单已完成", invalid: "订单无效·未收到付款" };
const STATUS_LABEL_EN = { awaiting_quote: "Awaiting quote", pending_payment: "Awaiting payment", received: "Order received", completed: "Completed", invalid: "Invalid · unpaid" };
const TX_STATUS_EN = { "待审核": "Pending review", "提现中": "Processing", "提现成功": "Withdrawn", "审核失败": "Rejected" };

// 到期日文案(北京时间日期)
function expiryDateText(iso, locale = "zh") {
  const ts = new Date(iso || 0).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return locale === "en" ? `${y}-${m}-${day}` : `${y}年${m}月${day}日`;
}

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

function googleOAuthStartUrl(inviteCode) {
  const code = String(inviteCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
  return code ? `${GOOGLE_OAUTH_START}?invite=${encodeURIComponent(code)}` : GOOGLE_OAUTH_START;
}

function handleGoogleOAuthStart(event) {
  const href = googleOAuthStartUrl(getStoredInviteCode());
  if (href === GOOGLE_OAUTH_START) return;
  event.preventDefault();
  window.location.href = href;
}

function inviteLink(code) {
  if (!code) return "";
  return `${INVITE_LINK_ORIGIN}/?invite=${encodeURIComponent(code)}`;
}

function maskOrderId(orderId) {
  const value = String(orderId || "").trim().toUpperCase();
  if (!value) return "";
  if (value.length <= 8) return value.replace(/^(.{2}).+(.{2})$/, "$1****$2");
  const start = Math.max(2, Math.floor((value.length - 6) / 2));
  return value.slice(0, start) + "******" + value.slice(start + 6);
}

function displayTxReason(tx, locale = "zh") {
  if (tx?.source === "referral" && tx.orderId) {
    const lvl = Number(tx.referralLevel || 1) === 2;
    return locale === "en"
      ? `Partner earnings ${maskOrderId(tx.orderId)} · ${lvl ? "L2 5%" : "L1 10%"}`
      : `合伙人收益 ${maskOrderId(tx.orderId)} · ${lvl ? "二级5%" : "一级10%"}`;
  }
  const reason = String(tx?.reason || "");
  const orderId = String(tx?.orderId || "").trim();
  const masked = orderId ? reason.replace(orderId, maskOrderId(orderId)) : reason;
  if (locale !== "en") return masked;
  // Localize the stored Chinese reason patterns for English users
  return masked
    .replace(/^订单支付\s*/, "Order payment ")
    .replace(/^订单提交失败退款\s*/, "Order failed — refund ")
    .replace(/^兑换码充值\s*/, "Code top-up ")
    .replace(/^转账给\s*/, "Transfer to ")
    .replace(/^收到\s*(.+?)\s*转账$/, "Received from $1")
    .replace(/^提现申请$/, "Withdrawal request")
    .replace(/^提现审核失败退回$/, "Withdrawal rejected — refunded")
    .replace(/^提现重新审核冻结$/, "Withdrawal re-review — held")
    .replace(/^合伙人收益\s*/, "Partner earnings ")
    .replace(/·\s*一级10%/, "· L1 10%")
    .replace(/·\s*二级5%/, "· L2 5%");
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
  const { locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const [state, setState] = useState({ loading: true, email: null, username: "", avatarId: DEFAULT_USER_AVATAR_ID, orders: [], balance: 0, txs: [], coupons: [], withdrawals: [], referral: null, referralDownlines: [] });
  const [activeOrder, setActiveOrder] = useState(null);
  const [afterSalesOrder, setAfterSalesOrder] = useState(null);
  const [afterSalesForm, setAfterSalesForm] = useState(null);
  const [afterSalesBusy, setAfterSalesBusy] = useState(false);
  const [afterSalesStatus, setAfterSalesStatus] = useState(null);
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

  useEffect(() => {
    if (!afterSalesOrder) return;
    document.body.style.overflow = "hidden";
    const onKey = (event) => { if (event.key === "Escape" && !afterSalesBusy) setAfterSalesOrder(null); };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = ""; document.removeEventListener("keydown", onKey); };
  }, [afterSalesOrder, afterSalesBusy]);

  function openAfterSales(order) {
    if (!order?.afterSalesEligible || !order?.afterSalesToken || order?.afterSalesTicket?.status === "pending") return;
    const sourceItems = Array.isArray(order.items) && order.items.length ? order.items : [];
    setAfterSalesOrder(order);
    setAfterSalesForm({
      email: order.email || state.email || "",
      contact: order.contact || "",
      remark: order.remark || "",
      issue: "",
      items: sourceItems.map((item, index) => ({
        index,
        service: item.service || "",
        label: item.label || order.serviceLabel || L("订单服务", "Order service"),
        account: item.account || "",
        password: item.password || "",
        platformUrl: item.platformUrl || order.platformUrl || "",
        productPrice: item.productPrice || order.productPrice || "",
      })),
    });
    setAfterSalesStatus(null);
  }

  function updateAfterSalesField(field, value) {
    setAfterSalesForm((current) => current ? { ...current, [field]: value } : current);
  }

  function updateAfterSalesItem(index, field, value) {
    setAfterSalesForm((current) => current ? {
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item),
    } : current);
  }

  function attachAfterSalesTicket(orderId, ticket) {
    if (!ticket) return;
    setState((current) => ({
      ...current,
      orders: current.orders.map((order) => order.orderId === orderId ? { ...order, afterSalesTicket: ticket } : order),
    }));
    setActiveOrder((order) => order?.orderId === orderId ? { ...order, afterSalesTicket: ticket } : order);
    setAfterSalesOrder((order) => order?.orderId === orderId ? { ...order, afterSalesTicket: ticket } : order);
  }

  async function submitAfterSales(event) {
    event.preventDefault();
    if (!afterSalesOrder || !afterSalesForm || afterSalesBusy) return;
    setAfterSalesBusy(true);
    setAfterSalesStatus(null);
    try {
      const response = await fetch("/api/after-sales", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: afterSalesOrder.orderId,
          token: afterSalesOrder.afterSalesToken,
          issue: afterSalesForm.issue,
          contact: afterSalesForm.contact,
          remark: afterSalesForm.remark,
          items: afterSalesForm.items,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (data.error === "pending_ticket_exists" && data.ticket) {
          attachAfterSalesTicket(afterSalesOrder.orderId, data.ticket);
          setAfterSalesStatus({ type: "success", ticketId: data.ticket.ticketId, emailWarning: false });
          return;
        }
        const message = {
          verification_required: L("登录凭证已过期，请重新登录后再试", "Your session expired. Sign in again and retry."),
          order_not_eligible: L("无效订单暂不支持提交售后工单", "After-sales tickets are unavailable for invalid orders."),
          issue_required: L("请至少用 5 个字说明需要处理的问题", "Please describe the issue in at least five characters."),
          missing_credentials: L("请完整填写该服务的账号与密码", "Enter the full account and password for this service."),
          missing_proxy_details: L("请完整填写网站链接与商品标价", "Enter the website link and listed price."),
          contact_required: L("请填写有效联系方式", "Enter a valid contact."),
        }[data.error] || L("售后工单提交失败，请稍后再试", "Ticket submission failed. Please try again.");
        throw new Error(message);
      }
      attachAfterSalesTicket(afterSalesOrder.orderId, data.ticket);
      setAfterSalesStatus({ type: "success", ticketId: data.ticket.ticketId, emailWarning: !data.notice?.email });
    } catch (error) {
      setAfterSalesStatus({ type: "error", message: error?.message || L("售后工单提交失败，请稍后再试", "Ticket submission failed. Please try again.") });
    } finally {
      setAfterSalesBusy(false);
    }
  }

  async function refreshAuthCaptcha(clearAnswer = true) {
    setAuthCaptcha((cur) => ({ ...cur, loading: true, error: "" }));
    if (clearAnswer) setAuthForm((f) => ({ ...f, captchaAnswer: "" }));
    try {
      const res = await fetch("/api/auth/captcha", { credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.token || !data.image) throw new Error(data.message || L("验证码加载失败", "Failed to load captcha"));
      setAuthCaptcha({ token: data.token, image: data.image, loading: false, error: "" });
    } catch (e) {
      setAuthCaptcha({ token: "", image: "", loading: false, error: L("验证码加载失败，请点击刷新", "Couldn't load captcha. Tap to refresh.") });
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
    if (status === "oauth_new") setAuthNotice(L("注册成功,新用户 ¥8.88 优惠券已发放,结算时自动抵扣", "Signed up! A ¥8.88 new-user coupon has been issued and applies automatically at checkout."));
    if (status === "oauth_ok") setAuthNotice(L("Google 登录成功", "Signed in with Google"));
    const oauthErrorMap = {
      google_not_configured: L("第三方登录暂不可用,请先使用邮箱登录或注册", "Third-party sign-in is unavailable. Please use email sign-in or sign-up."),
      invalid_oauth_state: L("Google 登录状态已失效，请重新点击 Google 登录", "Google sign-in session expired. Please tap Sign in with Google again."),
      invalid_client: L("Google Client ID 或 Client Secret 不匹配，请检查 Vercel 环境变量和 Google Cloud OAuth 客户端", "Google Client ID or Secret mismatch. Please check the Vercel env vars and your Google Cloud OAuth client."),
      redirect_uri_mismatch: L("Google 回调地址不匹配，请在 Google Cloud 中添加 https://www.liumeiti.vip/api/auth/oauth/google/callback", "Google redirect URI mismatch. Add https://www.liumeiti.vip/api/auth/oauth/google/callback in Google Cloud."),
      access_denied: L("你取消了 Google 授权", "You cancelled Google authorization."),
      oauth_failed: L("Google 登录失败，请稍后重试或使用邮箱登录", "Google sign-in failed. Please retry or use email sign-in."),
      email_not_verified: L("Google 邮箱未验证，暂时无法登录", "Your Google email isn't verified, so sign-in isn't available yet."),
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
        setAuthNotice(L("验证码已发送至邮箱。请查看收件箱(或垃圾邮件)", "A code has been sent to your email. Check your inbox (or spam)."));
        setAuthMode("reset");
        setAuthForm((f) => ({ ...f, code: "", newPassword: "" }));
        return;
      }
      if (data.ok) {
        await load();
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
      if (authMode === "register" && data.error === "captcha_failed") refreshAuthCaptcha(true);
      setAuthError(msg);
    } catch (error) {
      setAuthError(L("网络错误", "Network error"));
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
          <span>{L("Maoyang X CASETiFY · 至 2026.12.31", "Maoyang X CASETiFY · until 2026.12.31")}</span>
          <strong>{L("消费充值送 CASETiFY 手机壳", "Free CASETiFY case on spend / top-up")}</strong>
          <p>{L("注册用户消费满 ¥999，或单次充值 ¥1666，可联系客服领取", "Reach ¥999 in total account spending, or make a single ¥1666 top-up — then claim via support")}</p>
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
              <div className="account-modal-status">{L("活动至 2026.12.31", "Until 2026.12.31")}</div>
            </div>
            <button type="button" className="account-modal-close" onClick={() => setCasetifyModal(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="account-invite-modal-body">
            <div className="account-invite-hero account-casetify-hero">
              <span><Gift size={15} />{L("注册用户专享奖励", "Members-only reward")}</span>
              <strong>{L("消费充值送 CASETiFY 手机壳", "Free CASETiFY case on spend / top-up")}</strong>
              <p>{L("注册用户累计消费满 ¥999，或单次充值 ¥1666，可联系在线客服领取 CASETiFY 官网在售任意手机壳 1 个，支持定制款", "Once your cumulative account spending reaches ¥999, or you make a single ¥1666 top-up, contact support to claim any one case from the CASETiFY store, custom designs included")}</p>
            </div>
            <div className="account-casetify-intro">
              <strong>{L("关于 CASETiFY 手机壳", "About CASETiFY cases")}</strong>
              <p>{L("CASETiFY 手机壳主打防摔保护、丰富联名与个性化定制，适合想兼顾日常保护和外观风格的用户，奖品将在登记领取后七个工作日内由 CASETiFY 官方发出，并向您提供包囊跟踪编号", "CASETiFY cases focus on drop protection, rich collabs and personalization — ideal if you want daily protection with style. Prizes ship from CASETiFY within seven business days of registration, with a tracking number provided.")}</p>
            </div>
            <div className="account-invite-rule-list account-casetify-rule-list">
              <div>
                <b>{L("领取条件", "Eligibility")}</b>
                <p>{L("活动有效期至 2026 年 12 月 31 日，注册用户累计消费满 ¥999，或单次充值 ¥1666，即可联系客服免费领取", "Valid until Dec 31, 2026. Once your cumulative account spending reaches ¥999, or you make a single ¥1666 top-up, you can claim free via support.")}</p>
              </div>
              <div>
                <b>{L("可选款式", "Available styles")}</b>
                <p>{L("支持 CASETiFY 官网在售任意手机壳款式，包含可定制款，具体机型与库存以官网展示为准", "Any case style on sale at the CASETiFY store, custom designs included. Models and stock follow the official site.")}</p>
              </div>
              <div>
                <b>{L("收货范围", "Shipping scope")}</b>
                <p>{L("本活动暂不支持中国大陆地址收货，请确认可提供支持配送的收货地址，活动奖品不支持折现", "Shipping to mainland China is not supported for now. Please provide a deliverable address; the prize cannot be exchanged for cash.")}</p>
              </div>
              <div>
                <b>{L("领取说明", "Claim notes")}</b>
                <p>{L("领取奖品后，对应充值金额仅可用于本站消费，不支持退款与提现，确认领取即视为认可活动说明", "Once claimed, the matching top-up amount can only be used on this site, with no refund or withdrawal. Claiming means you accept these terms.")}</p>
              </div>
            </div>
            <div className="account-casetify-actions">
              <a href="https://www.casetify.com/" target="_blank" rel="noreferrer">
                <ExternalLink size={14} />{L("查看有什么款式", "Browse styles")}
              </a>
              <Link href="/service-center#contact" onClick={() => setCasetifyModal(false)}>
                <Send size={14} />{L("联系在线客服", "Contact support")}
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
        setNameError(data.message || L("用户名格式无效", "Invalid username format"));
      }
    } catch (e) {
      setNameError(L("网络错误", "Network error"));
    } finally {
      setNameSaving(false);
    }
  }

  function updateMoneyField(field, value) {
    setMoneyForm((cur) => ({ ...cur, [field]: value }));
    if (moneyStatus) setMoneyStatus(null);
  }

  async function submitMoneyAction(action, endpoint, payload, resetFields = []) {
    if (moneyBusy) return;
    // 客户端金额预校验：即时反馈，避免往返到服务端才报错
    if (action === "transfer" || action === "withdraw") {
      const amt = Number(payload.amount);
      if (!(amt > 0)) { setMoneyStatus({ type: "error", message: L("请输入大于 0 的金额", "Enter an amount greater than 0") }); return; }
      if (amt > Number(state.balance || 0)) { setMoneyStatus({ type: "error", message: L(`余额不足，当前余额 ¥${Number(state.balance || 0).toFixed(2)}`, `Insufficient balance (¥${Number(state.balance || 0).toFixed(2)})`) }); return; }
      if (action === "transfer" && String(payload.email || "").trim().toLowerCase() === String(state.email || "").trim().toLowerCase()) {
        setMoneyStatus({ type: "error", message: L("不能转账给自己", "You can't transfer to yourself") }); return;
      }
    }
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
      if (!data.ok) throw new Error(data.message || data.error || L("操作失败", "Action failed"));
      setMoneyStatus({ type: "success", message: data.message || L("操作成功", "Done") });
      setMoneyForm((cur) => {
        const next = { ...cur };
        resetFields.forEach((k) => { next[k] = ""; });
        return next;
      });
      setMoneyModal(null);
      await load();
    } catch (e) {
      setMoneyStatus({ type: "error", message: e.message || L("操作失败,请稍后再试", "Action failed, please try again") });
    } finally {
      setMoneyBusy("");
    }
  }

  if (state.loading) {
    return (
      <div className="account-page">
        <div className="account-loading" role="status" aria-live="polite">
          <LoaderCircle size={28} className="spin-icon" />
          <p style={{ margin: "12px 0 0", fontSize: 13.5, color: "var(--muted, #6e6e73)", fontWeight: 500 }}>{L("正在载入账户…", "Loading your account…")}</p>
        </div>
      </div>
    );
  }

  if (!state.email) {
    return (
      <div className="account-page account-auth-page">
        <header className="account-header">
          <Link href="/" className="account-brand-only" aria-label={L("冒央会社首页", "Maoyang Taiwan Inc home")}>
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="account-logo" />
          </Link>
        </header>
        <main className="account-main">
          <button type="button" className="account-invite-poster" onClick={() => setActivityModal(true)}>
            <div className="account-invite-poster-icon"><BadgePercent size={20} /></div>
            <div>
              <span>{L("合伙人计划 · 长期有效", "Partner program · always on")}</span>
              <strong>{L("注册即可获得专属邀请链接", "Sign up to get your invite link")}</strong>
              <p>{L("分享稳定好用的流媒体服务，一次推荐可持续获得长期收益", "Share reliable streaming memberships and earn recurring rewards from every referral")}</p>
            </div>
          </button>
          {renderCasetifyActivityCard()}
          <section className="auth-modal account-auth-card">
            <div className="auth-modal-head">
              {authMode === "login" || authMode === "register" ? (
                <div className="auth-modal-tabs">
                  <button type="button" className={`auth-tab${authMode === "login" ? " active" : ""}`} onClick={() => setAuthMode("login")}>{L("登录", "Sign in")}</button>
                  <button type="button" className={`auth-tab register-tab${authMode === "register" ? " active" : ""}`} onClick={() => setAuthMode("register")}>
                    {L("注册", "Sign up")}
                    <span className="auth-tab-tip">{L("立减¥8.88", "¥8.88 off")}</span>
                  </button>
                </div>
              ) : (
                <div className="auth-modal-title">{authMode === "forgot" ? L("找回密码", "Reset password") : L("重置密码", "Set new password")}</div>
              )}
            </div>
            <form className="auth-form" onSubmit={doAuth}>
              <label className="auth-field">
                <span>{L("邮箱", "Email")}</span>
                <input type="email" value={authForm.email} onChange={(e) => setAuthForm((f) => ({ ...f, email: e.target.value }))} placeholder="example@email.com" required />
              </label>
              {(authMode === "login" || authMode === "register") && (
                <label className="auth-field">
                  <span>{authMode === "register" ? L("密码 (6-64 位)", "Password (6-64 chars)") : L("密码", "Password")}</span>
                  <input type="password" value={authForm.password} onChange={(e) => setAuthForm((f) => ({ ...f, password: e.target.value }))} placeholder={authMode === "register" ? L("设置一个密码", "Create a password") : L("登录密码", "Your password")} required />
                </label>
              )}
              {authMode === "register" && (
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
              {authMode === "reset" && (
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
              <button type="submit" className="auth-submit" disabled={authBusy || (authMode === "register" && (authCaptcha.loading || !authCaptcha.token))}>
                {authBusy ? <><LoaderCircle size={14} className="spin-icon" />{L("处理中", "Processing")}</> : authMode === "register" ? L("注册并登录", "Sign up & sign in") : authMode === "forgot" ? L("发送验证码", "Send code") : authMode === "reset" ? L("重置并登录", "Reset & sign in") : L("登录", "Sign in")}
              </button>
              {(authMode === "login" || authMode === "register") && (
                <>
                  <div className="auth-divider"><span>{L("或使用", "or")}</span></div>
                  <div className="oauth-login-grid bottom">
                    <a href={GOOGLE_OAUTH_START} className="oauth-login-btn" onClick={handleGoogleOAuthStart}><GoogleIcon />{L("Google 登录", "Sign in with Google")}</a>
                  </div>
                </>
              )}
              <div className="auth-hints">
                {authMode === "login" && (
                  <>
                    <button type="button" className="auth-switch" onClick={() => setAuthMode("forgot")}>{L("忘记密码?", "Forgot password?")}</button>
                    <span className="auth-hint">{L("还没账号?", "No account?")} <button type="button" className="auth-switch" onClick={() => setAuthMode("register")}>{L("立即注册", "Sign up")}</button></span>
                  </>
                )}
                {authMode === "register" && <span className="auth-hint">{L("已有账号?", "Have an account?")} <button type="button" className="auth-switch" onClick={() => setAuthMode("login")}>{L("去登录", "Sign in")}</button></span>}
                {authMode === "forgot" && <button type="button" className="auth-switch" onClick={() => setAuthMode("login")}>{L("返回登录", "Back to sign in")}</button>}
                {authMode === "reset" && <button type="button" className="auth-switch" onClick={() => setAuthMode("forgot")}>{L("重新发送验证码", "Resend code")}</button>}
              </div>
            </form>
          </section>
        </main>
        {activityModal && (
          <div className="account-modal-mask" onClick={() => setActivityModal(false)}>
            <div className="account-money-modal account-activity-modal" onClick={(e) => e.stopPropagation()}>
              <div className="account-modal-head">
                <div>
                  <div className="account-modal-id">{L("合伙人计划", "Partner program")}</div>
                  <div className="account-modal-status">{L("最高 15% 佣金，活动长期有效", "Up to 15% commission · always on")}</div>
                </div>
                <button type="button" className="account-modal-close" onClick={() => setActivityModal(false)}>
                  <X size={16} />
                </button>
              </div>
              <div className="account-invite-modal-body">
                <div className="account-invite-hero">
                  <span><BadgePercent size={15} />{L("注册即可获得专属邀请链接", "Sign up to get your invite link")}</span>
                  <strong>{L("优质服务更好推广，一次分享长期收益", "Great service sells itself — share once, earn long-term")}</strong>
                  <p>{L("把高性价比会员与稳定售后分享给朋友或社群，好友完成有效订单后，收益会自动计入账户余额", "Share value-for-money memberships and reliable support with friends or your community. Once they complete a valid order, your earnings are credited to your balance automatically.")}</p>
                </div>
                <div className="account-invite-rule-list">
                  <div><b>{L("服务好推广", "Easy to promote")}</b><p>{L("主流会员、节点服务与售后协助一站完成，朋友更容易理解也更愿意复购", "Mainstream memberships, VPN service and support all in one place — easy for friends to grasp and re-order.")}</p></div>
                  <div><b>{L("分享成交收益", "Earn on every sale")}</b><p>{L("好友通过你的链接下单并完成服务后，你可获得实付金额 10% 佣金", "When a friend orders via your link and the service completes, you earn 10% of the amount paid.")}</p></div>
                  <div><b>{L("长期客户收益", "Recurring earnings")}</b><p>{L("好友通过你的链接注册后，会成为你的一级用户，后续有效订单也会持续带来 10% 收益", "Friends who sign up via your link become your L1 users — their future valid orders keep earning you 10%.")}</p></div>
                  <div><b>{L("团队扩散奖励", "Team bonus")}</b><p>{L("一级用户继续邀请新用户后，你也可获得二级用户有效订单 5% 奖励，分享越久积累越多", "When your L1 users invite others, you also earn 5% on those L2 valid orders — it adds up over time.")}</p></div>
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
      if (!data.ok) throw new Error(data.message || L("头像保存失败", "Failed to save avatar"));
      setState((s) => ({ ...s, avatarId: normalizeUserAvatarId(data.avatarId || avatarId) }));
      setAvatarModal(false);
    } catch (e) {
      setAvatarError(e.message || L("头像保存失败，请稍后再试", "Failed to save avatar, please try again"));
    } finally {
      setAvatarSaving("");
    }
  }

  const activeCoupon = state.coupons.find((c) => c.status === "active");

  return (
    <div className="account-page">
      <header className="account-header">
        <Link href="/" className="account-brand-only" aria-label={L("冒央会社首页", "Maoyang Taiwan Inc home")}>
          <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="account-logo" />
        </Link>
        <button type="button" className="account-logout" onClick={logout}>
          <LogOut size={13} />{L("退出", "Log out")}
        </button>
      </header>

      <main className="account-main">
        <section className="account-info-card">
          <button type="button" className="account-avatar" onClick={() => setAvatarModal(true)} aria-label={L("更换头像", "Change avatar")}>
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
                  placeholder={L("2-20 位 中/英/数字/_", "2-20 chars: letters / digits / _")}
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
                <strong>{state.username || L("未设置", "Not set")}</strong>
                <button type="button" className="account-name-edit-btn" onClick={startEditName} aria-label={L("修改用户名", "Edit username")}><Edit3 size={11} /></button>
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
              {L("账户余额", "Balance")}
            </div>
            <div className="account-balance-value">¥{state.balance.toFixed(2)}</div>
          </div>
          <button
            type="button"
            className="account-balance-toggle"
            onClick={() => setTxModal(true)}
          >
            {L(`查看余额明细 · ${state.txs.length} 笔`, `View transactions · ${state.txs.length}`)}
          </button>
        </section>

        <section className="account-money-tools">
          {moneyStatus && <div className={`account-tool-alert ${moneyStatus.type}`}>{moneyStatus.message}</div>}
          <div className="account-tool-buttons">
            <button type="button" onClick={() => setMoneyModal("transfer")}><Send size={13} />{L("转账", "Transfer")}</button>
            <button type="button" onClick={() => setMoneyModal("withdraw")}><CreditCard size={13} />{L("提现", "Withdraw")}</button>
            <button type="button" onClick={() => setDownlineModal(true)}><Users size={13} />{L("下级", "Team")}</button>
            <button type="button" onClick={() => setInviteModal(true)}><Share2 size={13} />{L("邀请", "Invite")}</button>
          </div>

          <div className="account-coupon-strip">
            <Gift size={13} />
            <strong>{activeCoupon ? `${L("可用优惠券", "Coupon")} ¥${Number(activeCoupon.amount || 0).toFixed(2)}` : L("暂无可用优惠券", "No coupon available")}</strong>
            <span>{L("付款自动抵扣", "Auto-applied at checkout")}</span>
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
            <div className="account-tool-head"><Send size={14} />{L("邮箱转账", "Transfer by email")}</div>
            <label className="account-tool-field">
              <span>{L("收款邮箱", "Recipient email")}</span>
              <input value={moneyForm.transferEmail} onChange={(e) => updateMoneyField("transferEmail", e.target.value)} placeholder={L("对方注册邮箱", "Their account email")} inputMode="email" required />
            </label>
            <label className="account-tool-field">
              <span>{L("转账金额", "Amount")}</span>
              <input value={moneyForm.transferAmount} onChange={(e) => updateMoneyField("transferAmount", e.target.value)} placeholder="0.00" inputMode="decimal" required />
            </label>
            <button type="submit" disabled={moneyBusy === "transfer"}>{moneyBusy === "transfer" ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}{L("确认转账", "Confirm transfer")}</button>
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
            <div className="account-tool-head"><Gift size={14} />{L("余额兑换码", "Balance code")}</div>
            <label className="account-tool-field full">
              <span>{L("兑换码", "Redeem code")}</span>
              <input value={moneyForm.redeemCode} onChange={(e) => updateMoneyField("redeemCode", e.target.value.toUpperCase())} placeholder={L("输入余额兑换码", "Enter your balance code")} autoComplete="off" required />
            </label>
            <button type="submit" disabled={moneyBusy === "redeem"}>{moneyBusy === "redeem" ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}{L("立即兑换", "Redeem now")}</button>
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
            <div className="account-tool-head"><CreditCard size={14} />{L("余额提现", "Withdraw balance")}</div>
            <label className="account-tool-field">
              <span>{L("提现金额", "Amount")}</span>
              <input value={moneyForm.withdrawAmount} onChange={(e) => updateMoneyField("withdrawAmount", e.target.value)} placeholder="0.00" inputMode="decimal" required />
            </label>
            <label className="account-tool-field">
              <span>{L("姓名", "Full name")}</span>
              <input value={moneyForm.realName} onChange={(e) => updateMoneyField("realName", e.target.value)} placeholder={L("支付宝实名", "Alipay real name")} autoComplete="name" required />
            </label>
            <label className="account-tool-field full">
              <span>{L("支付宝账号", "Alipay account")}</span>
              <input value={moneyForm.alipayAccount} onChange={(e) => updateMoneyField("alipayAccount", e.target.value)} placeholder={L("手机号 / 邮箱 / 支付宝账号", "Phone / email / Alipay ID")} required />
            </label>
            <button type="submit" disabled={moneyBusy === "withdraw"}>{moneyBusy === "withdraw" ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}{L("确认提现", "Confirm withdrawal")}</button>
          </form>
        </section>

        {renderCasetifyActivityCard()}

        <section className="account-orders">
          <div className="account-orders-head">
            <div>
              <div className="section-kicker">{L("我的订单", "My orders")}</div>
              <h2>{L("我的订单", "My orders")}</h2>
            </div>
            <span className="account-orders-count">{L(`${state.orders.length} 笔`, `${state.orders.length}`)}</span>
          </div>

          {state.orders.length === 0 ? (
            <div className="account-empty">
              <ShoppingBag size={36} />
              <p>{L("暂无订单", "No orders yet")}</p>
              <Link href="/shop" className="account-empty-cta">{L("前往选购", "Browse services")}</Link>
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
                      {(locale === "en" ? STATUS_LABEL_EN : STATUS_LABEL)[o.status]}
                    </span>
                  </div>
                  <div className="account-order-mid">
                    <span>{o.serviceLabel}</span>
                    {o.expiry && o.expiry.daysLeft <= 14 && (
                      <em className={`account-order-expiry ${o.expiry.expired ? "is-expired" : ""}`}>
                        {o.expiry.expired ? L("已到期", "Expired") : L(`剩 ${Math.max(o.expiry.daysLeft, 0)} 天`, `${Math.max(o.expiry.daysLeft, 0)}d left`)}
                      </em>
                    )}
                    {o.itemCount > 1 && <em>{L(`${o.itemCount} 件`, `${o.itemCount} items`)}</em>}
                  </div>
                  <div className="account-order-bot">
                    <span>{o.status === "awaiting_quote" ? L("待报价", "Custom quote") : o.status === "pending_payment" ? `${L("报价", "Quote")} ¥${Number(o.quoteAmount || 0).toFixed(2)}` : o.paidCurrency === "CODE" ? L("兑换码", "Code") : o.paidCurrency === "USDT" ? `${o.paidAmount} USDT` : `¥${o.paidAmount}`}</span>
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
                  {moneyModal === "transfer" ? L("邮箱转账", "Transfer by email") : moneyModal === "redeem" ? L("余额兑换码", "Balance code") : L("余额提现", "Withdraw balance")}
                </div>
                <div className="account-modal-status status-received">{L("当前余额", "Balance")} ¥{state.balance.toFixed(2)}</div>
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
                  <label className="account-tool-field full"><span>{L("收款邮箱", "Recipient email")}</span><input value={moneyForm.transferEmail} onChange={(e) => updateMoneyField("transferEmail", e.target.value)} placeholder={L("对方注册邮箱", "Their account email")} inputMode="email" required /></label>
                  <label className="account-tool-field full"><span>{L("转账金额", "Amount")}</span><input value={moneyForm.transferAmount} onChange={(e) => updateMoneyField("transferAmount", e.target.value)} placeholder="0.00" inputMode="decimal" required /></label>
                </>
              )}
              {moneyModal === "redeem" && (
                <label className="account-tool-field full"><span>{L("兑换码", "Redeem code")}</span><input value={moneyForm.redeemCode} onChange={(e) => updateMoneyField("redeemCode", e.target.value.toUpperCase())} placeholder={L("输入余额兑换码", "Enter your balance code")} autoComplete="off" required /></label>
              )}
              {moneyModal === "withdraw" && (
                <>
                  <label className="account-tool-field"><span>{L("提现金额", "Amount")}</span><input value={moneyForm.withdrawAmount} onChange={(e) => updateMoneyField("withdrawAmount", e.target.value)} placeholder="0.00" inputMode="decimal" required /></label>
                  <label className="account-tool-field"><span>{L("姓名", "Full name")}</span><input value={moneyForm.realName} onChange={(e) => updateMoneyField("realName", e.target.value)} placeholder={L("支付宝实名", "Alipay real name")} autoComplete="name" required /></label>
                  <label className="account-tool-field full"><span>{L("支付宝账号", "Alipay account")}</span><input value={moneyForm.alipayAccount} onChange={(e) => updateMoneyField("alipayAccount", e.target.value)} placeholder={L("手机号 / 邮箱 / 支付宝账号", "Phone / email / Alipay ID")} required /></label>
                </>
              )}
              {moneyStatus && <div className={`account-tool-alert ${moneyStatus.type}`}>{moneyStatus.message}</div>}
              <button type="submit" disabled={!!moneyBusy} className="account-money-submit">
                {moneyBusy ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}
                {moneyBusy ? L("处理中", "Processing") : moneyModal === "withdraw" ? L("确认提现", "Confirm withdrawal") : L("确认提交", "Confirm")}
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
                <div className="account-modal-id">{L("余额明细", "Transactions")}</div>
                <div className="account-modal-status status-received">{L("当前余额", "Balance")} ¥{state.balance.toFixed(2)}</div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setTxModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="account-tx-modal-body">
              <div className="account-tx-list">
                {state.txs.length === 0 ? (
                  <div className="account-tx-empty">{L("暂无余额变动记录", "No balance activity yet")}</div>
                ) : (
                  state.txs.map((tx) => (
                    <div key={tx.id} className={`account-tx-item${tx.amount > 0 ? " positive" : " negative"}`}>
                      <div className="account-tx-icon">
                        {tx.amount > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                      </div>
                      <div className="account-tx-info">
                        <strong>{displayTxReason(tx, locale)}</strong>
                        <small>{tx.createdAtBeijing}{tx.statusLabel ? ` · ${locale === "en" ? (TX_STATUS_EN[tx.statusLabel] || tx.statusLabel) : tx.statusLabel}` : ""}</small>
                      </div>
                      <div className="account-tx-amount">
                        {tx.amount > 0 ? "+" : ""}¥{Math.abs(tx.amount).toFixed(2)}
                      </div>
                    </div>
                  ))
                )}
                <div className="account-tx-note">
                  <AlertTriangle size={11} />
                  {L("余额仅用于网站会员服务下单时结算,如需充值请联系客服", "Balance is used only at checkout for membership services. To top up, please contact support.")}
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
                <div className="account-modal-id">{L("更换头像", "Change avatar")}</div>
                <div className="account-modal-status">{L("选择一个卡通头像", "Pick a cartoon avatar")}</div>
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
                      {active && <em><Check size={11} />{L("当前", "Current")}</em>}
                      {avatarSaving === avatar.id && <em><LoaderCircle size={11} className="spin-icon" />{L("保存中", "Saving")}</em>}
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
                <div className="account-modal-id">{L("我的下级", "My team")}</div>
                <div className="account-modal-status status-received">{L(`${state.referralDownlines.length} 位邀请用户`, `${state.referralDownlines.length} invited`)}</div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setDownlineModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="account-downline-list">
              {state.referralDownlines.length === 0 ? (
                <div className="account-downline-empty">
                  <Users size={18} />
                  <strong>{L("暂无下级用户", "No team members yet")}</strong>
                  <span>{L("复制邀请链接分享给好友，好友注册或下单后会在这里显示", "Copy your invite link and share it. Friends who sign up or order will show up here.")}</span>
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
                <div className="account-modal-id">{L("合伙人计划", "Partner program")}</div>
                <div className="account-modal-status">{L("最高 15% 佣金，活动长期有效", "Up to 15% commission · always on")}</div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setInviteModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="account-invite-modal-body">
              <div className="account-invite-hero">
                <span><BadgePercent size={15} />{L("专属邀请链接", "Your invite link")}</span>
                <strong>{L("一次分享，长期收益", "Share once, earn long-term")}</strong>
                <p>{L("把稳定好用的流媒体服务分享出去，有效订单完成后，合伙人收益会自动计入账户余额", "Share reliable streaming memberships. Once a valid order completes, partner earnings are credited to your balance automatically.")}</p>
              </div>
              <div className="account-invite-link-box">
                <span>{L("你的邀请链接", "Your invite link")}</span>
                <code>{inviteLink(state.referral?.inviteCode || "") || L("正在生成专属链接", "Generating your link")}</code>
                <button
                  type="button"
                  disabled={!state.referral?.inviteCode}
                  onClick={() => handleCopy(inviteLink(state.referral?.inviteCode || ""), "invite-link")}
                >
                  {copiedKey === "invite-link" ? L("已复制", "Copied") : <><Copy size={13} />{L("复制链接", "Copy link")}</>}
                </button>
              </div>
              <div className="account-invite-rule-list">
                <div>
                  <b>{L("直接分享成交", "Direct sales")}</b>
                  <p>{L("他人通过你的专属链接进入网站并完成有效订单后，你获得订单实付金额 10% 佣金", "When someone enters via your link and completes a valid order, you earn 10% of the amount paid.")}</p>
                </div>
                <div>
                  <b>{L("一级用户长期绑定", "L1 users stay yours")}</b>
                  <p>{L("他人通过你的链接注册账号后，会成为你的一级用户；该用户以后每次有效订单完成后，你都获得 10% 佣金", "Anyone who signs up via your link becomes your L1 user — you earn 10% on each of their future valid orders.")}</p>
                </div>
                <div>
                  <b>{L("二级用户奖励", "L2 bonus")}</b>
                  <p>{L("你的一级用户继续邀请新用户注册或下单，该新用户属于你的二级用户；有效订单完成后，你可获得 5% 二级佣金", "When your L1 users invite others, those become your L2 users — you earn 5% on their valid orders.")}</p>
                </div>
                <div>
                  <b>{L("收益规则", "Payout rules")}</b>
                  <p>{L("收益仅在有效订单完成后发放，未付款、异常订单、兑换码免支付订单不会产生有效佣金", "Earnings are paid only after a valid order completes. Unpaid, abnormal, or code-redeemed (no-pay) orders earn no commission.")}</p>
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
                  {(locale === "en" ? STATUS_LABEL_EN : STATUS_LABEL)[activeOrder.status]}
                </div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setActiveOrder(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="account-modal-body">
              <div className="query-after-sales-entry">
                {activeOrder.afterSalesTicket?.status === "pending" ? (
                  <div className="query-after-sales-pending">
                    <span><Clock size={17} /></span>
                    <div><strong>{L("售后工单待处理", "After-sales ticket pending")}</strong><small>{activeOrder.afterSalesTicket.ticketId} · {L("工作人员会尽快处理", "Our team will handle it shortly")}</small></div>
                  </div>
                ) : activeOrder.afterSalesEligible ? (
                  <button type="button" className="query-after-sales-btn" onClick={() => openAfterSales(activeOrder)}>
                    <span><LifeBuoy size={19} /></span>
                    <strong>{L("申请售后", "Request after-sales")}</strong>
                    <ArrowRight size={17} />
                  </button>
                ) : null}
              </div>
              <div className="account-modal-amount">
                <span>{activeOrder.status === "awaiting_quote" ? L("当前进度", "Current status") : activeOrder.status === "pending_payment" ? L("报价金额", "Quote") : L("实付金额", "Amount paid")}</span>
                <b>{activeOrder.status === "awaiting_quote" ? L("等待报价", "Awaiting quote") : activeOrder.status === "pending_payment" ? `¥${Number(activeOrder.quoteAmount || 0).toFixed(2)}` : activeOrder.paidCurrency === "CODE" ? L("服务兑换码", "Service code") : activeOrder.paidCurrency === "USDT" ? `${activeOrder.paidAmount} USDT` : `¥${activeOrder.paidAmount}`}</b>
                <em>{activeOrder.paymentMethod === "quote" ? L("人工报价", "Custom quote") : activeOrder.paymentMethod === "redeem" ? L("兑换码", "Code") : activeOrder.paymentMethod === "usdt" ? "USDT" : L("支付宝", "Alipay")}</em>
              </div>

              {activeOrder.orderType === "proxy_payment" && (
                <div className="account-proxy-order-info">
                  <div className="span-2"><span>{L("网站 / 平台", "Website / platform")}</span><a href={activeOrder.platformUrl} target="_blank" rel="noopener noreferrer">{activeOrder.platformUrl}<ExternalLink size={12} /></a></div>
                  <div><span>{L("商品标价", "Listed price")}</span><b>{activeOrder.productPrice}</b></div>
                  <div><span>{L("付款提示", "Payment")}</span><b>{activeOrder.status === "pending_payment" ? L("请查收报价邮件", "Check your quote email") : activeOrder.status === "awaiting_quote" ? L("报价将发送至邮箱", "Quote will be emailed") : L("已提交付款信息", "Payment submitted")}</b></div>
                </div>
              )}

              <div className="account-modal-items-label">{L(`商品明细 · ${activeOrder.itemCount} 件`, `Items · ${activeOrder.itemCount}`)}</div>
              <div className="account-modal-items">
                {activeOrder.items.map((it, idx) => (
                  <div key={idx} className="account-modal-item">
                    <div className="account-modal-item-head">
                      <strong>{it.label}</strong>
                      <span>{it.service === "proxy-pay" && !it.amount ? L("人工报价", "Custom quote") : `${it.cycle} · ¥${it.amount}`}</span>
                    </div>
                    {(it.account || it.password) && (
                      <div className="account-modal-creds">
                        {it.account && (
                          <div>
                            <span>{it.service === "rocket" ? L("用户名", "Username") : L("账号", "Account")}</span>
                            <code>{it.account}</code>
                            <button type="button" onClick={() => handleCopy(it.account, `acc-${idx}`)}>
                              {copiedKey === `acc-${idx}` ? L("已复制", "Copied") : <Copy size={11} />}
                            </button>
                          </div>
                        )}
                        {it.password && (
                          <div>
                            <span>{L("密码", "Password")}</span>
                            <code>{it.password}</code>
                            <button type="button" onClick={() => handleCopy(it.password, `pwd-${idx}`)}>
                              {copiedKey === `pwd-${idx}` ? L("已复制", "Copied") : <Copy size={11} />}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {it.subscriptionLinks && (
                      <div className="account-modal-subs">
                        <button type="button" onClick={() => handleCopy(it.subscriptionLinks.shadowrocket, `sr-${idx}`)}>
                          <div>
                            <strong>{L("Shadowrocket 订阅", "Shadowrocket sub")}</strong>
                            <small>{it.subscriptionLinks.shadowrocket}</small>
                          </div>
                          <em>{copiedKey === `sr-${idx}` ? L("已复制", "Copied") : L("复制", "Copy")}</em>
                        </button>
                        <button type="button" onClick={() => handleCopy(it.subscriptionLinks.clash, `cl-${idx}`)}>
                          <div>
                            <strong>{L("Clash 订阅", "Clash sub")}</strong>
                            <small>{it.subscriptionLinks.clash}</small>
                          </div>
                          <em>{copiedKey === `cl-${idx}` ? L("已复制", "Copied") : L("复制", "Copy")}</em>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {activeOrder.staffNotes && (
                <div className="account-modal-staff-notes">
                  <div className="account-modal-staff-notes-label">{L("客服备注", "Support note")}</div>
                  <div>{activeOrder.staffNotes}</div>
                </div>
              )}

              <div className="account-modal-meta">
                <div><span>{L("下单时间", "Ordered at")}</span><b>{activeOrder.createdAtBeijing}</b></div>
                {activeOrder.completedAtBeijing && (
                  <div><span>{L("完成时间", "Completed at")}</span><b>{activeOrder.completedAtBeijing}</b></div>
                )}
                {activeOrder.expiry && (
                  <div>
                    <span>{L("服务到期", "Service expires")}</span>
                    <b>
                      {expiryDateText(activeOrder.expiry.expiresAt, locale)}
                      {activeOrder.expiry.expired
                        ? ` · ${L("已到期", "expired")}`
                        : activeOrder.expiry.daysLeft > 0 ? ` · ${L(`剩 ${activeOrder.expiry.daysLeft} 天`, `${activeOrder.expiry.daysLeft}d left`)}` : ""}
                    </b>
                  </div>
                )}
                <div><span>{L("联系方式", "Contact")}</span><b>{activeOrder.contact}</b></div>
                {activeOrder.remark && (
                  <div><span>{L("下单备注", "Note")}</span><b>{activeOrder.remark}</b></div>
                )}
              </div>
              {activeOrder.expiry && activeOrder.expiry.daysLeft <= 14 && activeOrder.renewPath && (
                <Link href={activeOrder.renewPath} className="account-renew-cta">
                  <RefreshCw size={15} />
                  {activeOrder.expiry.expired ? L("已到期 · 一键续费", "Expired · Renew now") : L(`剩 ${Math.max(activeOrder.expiry.daysLeft, 0)} 天 · 一键续费`, `${Math.max(activeOrder.expiry.daysLeft, 0)}d left · Renew now`)}
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
      <AfterSalesTicketSheet
        order={afterSalesOrder}
        form={afterSalesForm}
        busy={afterSalesBusy}
        status={afterSalesStatus}
        onClose={() => !afterSalesBusy && setAfterSalesOrder(null)}
        onSubmit={submitAfterSales}
        onFieldChange={updateAfterSalesField}
        onItemChange={updateAfterSalesItem}
        L={L}
      />
      <FloatingSupport />
      <MobileNav />
    </div>
  );
}
