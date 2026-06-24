"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  Copy,
  Gift,
  Headphones,
  LoaderCircle,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { copyText } from "../lib/store";
import MobileNav from "../components/MobileNav";
import FloatingSupport from "../components/FloatingSupport";
import { QQBrandIcon, TelegramBrandIcon, WhatsAppBrandIcon } from "../components/BrandIcons";
import { useLocale } from "../components/LocaleProvider";

const ASSURANCE_CARDS_EN = [
  { title: "Reliable setup", desc: "Six years of streaming-service experience; orders are processed fast by our team", meta: "Pro & worry-free" },
  { title: "After-sales help", desc: "If an account, Profile or node has issues, reach our support — online every day, 9am–11pm", meta: "We've got your back" },
  { title: "Refund policy", desc: "If an account can't be used due to our side, a 7-day refund is supported; support helps troubleshoot first", meta: "Clear rules" },
  { title: "Order records", desc: "Order lookup info is kept, and orders are also emailed to your order email", meta: "Easy to track" },
];

const FAQ_EN = [
  { q: "How soon can I use it after ordering?", a: "Usually 5–10 minutes after payment, and within 1 hour at peak. Every order is checked for service and details to stay accurate and stable." },
  { q: "Is the account safe? Could it get banned?", a: "We use first-hand source channels, so accounts stay stable long-term. Spotify uses legitimate family invites; Netflix / Disney+ / HBO are lockable dedicated Profiles; VPN nodes use clean streaming-unlocked IPs. If anything goes wrong, just reach our online support." },
  { q: "What payment methods are there? Is it safe?", a: "Alipay escrow (recommended) and USDT (10% off) are supported. An order confirmation email is sent so lookup and after-sales stay clear." },
  { q: "Is after-sales supported?", a: "Yes. We support a 7-day refund for account-side issues, plus order consultation, online support and troubleshooting. Reach our online support team anytime." },
  { q: "How do I contact support?", a: "Reach us on QQ, WhatsApp or Telegram. Online hours are 9am–11pm Beijing time. Contact our online support team anytime." },
  { q: "About us?", a: "Maoyang Taiwan Inc is based in Taiwan, China and has focused on streaming memberships, usage guidance and after-sales since 2020. We value response speed, service experience and long-term reputation." },
  { q: "Can you customize enterprise or team plans?", a: "Yes. We have 200+ reseller partners. For long-term cooperation, bulk needs or enterprise scenarios, reach our online support to discuss." },
];

const STATUS_LABEL_EN = { received: "Order received", completed: "Completed", invalid: "Invalid · unpaid" };

const LAYOUT_CARDS = [
  ["选择/兑换服务", "Spotify / Netflix / Disney+ / Hbomax / 机场节点"],
  ["填写信息", "按照网站引导，准确填写你的订单所需的信息"],
  ["提交订单", "核查填写信息无误后提交订单，你的邮箱将收到订单确认信息"],
  ["售后服务", "完成后邮件通知，订单页可继续查询售后信息"],
];

const ASSURANCE_CARDS = [
  {
    title: "稳定开通",
    desc: "六年专业流媒体服务经验，订单提交后人工极速处理",
    meta: "专业省心",
    icon: BadgeCheck,
  },
  {
    title: "售后协助",
    desc: "账号、车位或节点遇到异常，请联系我们全年无休7x14在线客服处理",
    meta: "全程保驾护航",
    icon: Headphones,
  },
  {
    title: "退款规则",
    desc: "账号原因无法正常使用时支持 7 天内退款，客服会先协助排查",
    meta: "规则清晰",
    icon: RefreshCw,
  },
  {
    title: "订单记录",
    desc: "订单查询信息会持续保留，同时订单会同步发送至下单邮箱",
    meta: "查询更方便",
    icon: Lock,
  },
];

const FAQ = [
  {
    q: "下单后多久能用？",
    a: "支付完成后通常 5-10 分钟即可使用，高峰期不超过 1 小时。所有开通都会核对服务与资料，确保稳定准确",
  },
  {
    q: "账号安全有保障吗？会被封禁吗？",
    a: "我们自有源头渠道，账号长期稳定可用。Spotify 为正规家庭组邀请；Netflix / Disney+ / HBO 均为独立车位可上锁，长期稳定可用；机场节点均为已解锁流媒体纯净 IP，如出现问题联系在线客服解决即可",
  },
  {
    q: "支付方式有哪些？支付安全吗？",
    a: "支持支付宝担保支付（推荐）及 USDT 支付（9折）。订单确认邮件会同步发送，后续查询和售后都更清晰",
  },
  {
    q: "是否支持售后服务？",
    a: "支持。我们支持 7 天内账号原因退款，我们提供订单服务咨询、在线客服协助与问题排查，如您有任何问题，随时联系我们的在线客服团队",
  },
  {
    q: "如何联系在线客服？",
    a: "可通过 QQ、WhatsApp、Telegram 与我们联系，在线时间为北京时间早 9 点至晚 11 点，如您有任何问题，随时联系我们的在线客服团队",
  },
  {
    q: "关于我们？",
    a: "冒央会社来自中国台湾，自2020年起专注流媒体会员服务、使用指导、售后协助。我们重视响应速度、服务体验与长期口碑，持续为用户提供廉价、稳定、优质的服务",
  },
  {
    q: "是否可以定制企业或团队方案？",
    a: "可以。我们全网拥有 200+ 代理合作伙伴，若你有长期合作、批量需求或企业场景，可联系在线客服进一步沟通",
  },
];

const TESTIMONIALS = [
  { name: "陈**", initial: "陈", region: "首尔", service: "Spotify 家庭成员", rating: 5, date: "8分钟前", text: "长期续费都比较稳定，遇到问题客服回复及时，订单记录也方便查询" },
  { name: "Chueng****", initial: "L", region: "台北", service: "Netflix 4K", rating: 5, date: "30分钟前", text: "4K 杜比画质正常，独立车位互不影响，全家一起看也够用" },
  { name: "Mia****", initial: "M", region: "深圳", service: "机场节点", rating: 5, date: "9小时前", text: "看流媒体 4K 不缓冲，日常使用其他应用也很流畅，套餐说明清楚" },
  { name: "張*", initial: "張", region: "香港", service: "Disney+", rating: 5, date: "一天前", text: "下单后很快收到确认，电视端登录正常，已经推荐给朋友" },
  { name: "Yammy***", initial: "Y", region: "伦敦", service: "HBO Max", rating: 5, date: "两天前", text: "客服全程指导，账号到现在使用稳定，续费会继续考虑这里" },
  { name: "李**", initial: "李", region: "北京", service: "Spotify+Netflix+机场节点", rating: 5, date: "两天前", text: "组合下单更省事，听歌、刷剧和节点服务一次处理好，售后也能接上" },
  { name: "王*", initial: "王", region: "烟台", service: "机场节点 · 普通套餐", rating: 5, date: "14分钟前", text: "订阅导入简单，50GB/月真实流量说明清楚，日常使用够用了" },
  { name: "周**", initial: "周", region: "徐州", service: "Spotify 家庭成员", rating: 5, date: "25分钟前", text: "邀请说明清楚，付款后很快能用，后续有问题也能带订单沟通" },
  { name: "黄*", initial: "黄", region: "嘉兴", service: "Netflix 4K 杜比", rating: 5, date: "45分钟前", text: "客服响应快，电视端播放稳定，家里人追剧没有再遇到卡顿" },
  { name: "朱*", initial: "朱", region: "临沂", service: "机场节点 + Netflix", rating: 5, date: "1小时前", text: "组合下单比较划算，刷剧和日常使用都能覆盖，邮件记录也完整" },
  { name: "林**", initial: "林", region: "桂林", service: "HBO Max", rating: 5, date: "2小时前", text: "独立车位稳定，开通信息清楚，一年下来价格也合适" },
  { name: "郑**", initial: "郑", region: "北海", service: "Disney+ 4K", rating: 5, date: "4小时前", text: "孩子看动画很流畅，4K 杜比效果正常，客服说明简单直接" },
  { name: "杨*", initial: "杨", region: "大理", service: "机场节点 · 无限套餐", rating: 5, date: "8小时前", text: "家里多设备一起用更适合无限套餐，节点速度和稳定性都不错" },
  { name: "吴**", initial: "吴", region: "银川", service: "Spotify + HBO Max", rating: 5, date: "12小时前", text: "听歌和追剧一起处理，价格清楚，后续查询订单也方便" },
  { name: "谢*", initial: "谢", region: "包头", service: "Netflix 4K", rating: 5, date: "一天前", text: "独立车位看 4K 不容易被打扰，画质和音效都正常" },
  { name: "韩**", initial: "韩", region: "抚顺", service: "机场节点 · 无限套餐", rating: 5, date: "两天前", text: "路由器、手机和电视一起用也稳定，适合家里多设备场景" },
  { name: "沈*", initial: "沈", region: "运城", service: "Disney+", rating: 5, date: "三天前", text: "一年使用下来比较稳定，客服记录清楚，准备继续续费" },
  { name: "姚**", initial: "姚", region: "中山", service: "Spotify 家庭成员", rating: 5, date: "四天前", text: "家庭计划邀请流程清楚，音质和歌单都正常，整体比较省心" },
];

const SUPPORT_CHANNELS = [
  { label: "QQ", value: "2802632995", copyValue: "2802632995" },
  { label: "WhatsApp", value: "+34 671143339", copyValue: "+34 671143339" },
  { label: "Telegram", value: "@MaoyangSupport", copyValue: "@MaoyangSupport" },
];

const STATUS_LABEL = { received: "订单已收到", completed: "订单已完成", invalid: "订单无效·未收到付款" };

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

function paymentLabel(order, locale = "zh") {
  if (order.paymentMethod === "redeem") return locale === "en" ? "Code" : "兑换码";
  return order.paymentMethod === "usdt" ? "USDT" : (locale === "en" ? "Alipay" : "支付宝");
}

export default function ServiceCenterPage() {
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
  const [queryInput, setQueryInput] = useState("");
  const [queryCode, setQueryCode] = useState("");
  const [queryVerification, setQueryVerification] = useState(null);
  const [queryStatus, setQueryStatus] = useState(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryResults, setQueryResults] = useState([]);
  const [queryDetailOrder, setQueryDetailOrder] = useState(null);
  const [faqOpen, setFaqOpen] = useState(0);
  const [copiedKey, setCopiedKey] = useState("");
  const { locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const assuranceCards = ASSURANCE_CARDS.map((c, i) => (locale === "en" ? { ...c, ...ASSURANCE_CARDS_EN[i] } : c));
  const faqList = locale === "en" ? FAQ_EN : FAQ;
  const statusLabel = locale === "en" ? STATUS_LABEL_EN : STATUS_LABEL;

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => setAuthUser(d.ok ? { email: d.email, username: d.username, balance: Number(d.balance || 0) } : false))
      .catch(() => setAuthUser(false));
  }, []);

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = (params.get("redeem") || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const order = params.get("order");
    if (code) {
      window.location.replace(`/?redeem=${encodeURIComponent(code)}#redeem`);
      return;
    }
    if (order && order.length > 4) {
      setQueryInput(order);
      setTimeout(() => runQuery(order), 100);
    }
    if (process.env.NODE_ENV !== "production" && params.get("verifyPreview") === "1") {
      const previewQuery = params.get("query") || "LMTEST123456";
      setQueryInput(previewQuery);
      setQueryVerification({ query: previewQuery, emailHint: "ma****@example.com" });
      setQueryCode("");
      setQueryStatus({ type: "info", message: L("验证码已发送至 ma****@example.com，请输入 6 位验证码继续查询", "A code was sent to ma****@example.com. Enter the 6-digit code to continue.") });
    }
  }, []);

  function normalizeRedeemCode(value) {
    return String(value || "").replace(/\s+/g, "").replace(/[＿_—–]/g, "-").toUpperCase();
  }

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
        setAuthNotice(L("余额兑换码需要先登录账号,登录后再次点击兑换即可到账", "Balance codes require sign-in. Sign in, then tap redeem again to credit your balance."));
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
      setRedeemStatus({ type: "success", message: L(`兑换成功,余额已到账，当前余额 ¥${Number(data.balance || 0).toFixed(2)}`, `Redeemed! Balance updated — current balance ¥${Number(data.balance || 0).toFixed(2)}`) });
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
      const endpoint = authModal;
      let payload = {};
      if (authModal === "login") payload = { email: authForm.email.trim(), password: authForm.password };
      if (authModal === "register") payload = {
        email: authForm.email.trim(),
        password: authForm.password,
        captchaToken: authCaptcha.token,
        captchaAnswer: authForm.captchaAnswer.trim(),
      };
      if (authModal === "forgot") payload = { email: authForm.email.trim() };
      if (authModal === "reset") payload = {
        email: authForm.email.trim(),
        code: authForm.code.trim(),
        newPassword: authForm.newPassword,
      };

      const res = await fetch(`/api/auth/${endpoint}`, {
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
        setAuthUser({ email: data.email });
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

  async function runQuery(query, code = "") {
    const value = String(query || "").trim();
    if (!value) {
      setQueryStatus({ type: "error", message: L("请输入完整订单号或下单邮箱", "Enter your full order ID or order email") });
      setQueryResults([]);
      return;
    }
    setQueryLoading(true);
    setQueryStatus({ type: "info", message: code ? L("正在核验验证码...", "Verifying the code...") : L("正在发送邮箱验证码...", "Sending the email code...") });
    try {
      const response = await fetch("/api/order-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: value, code }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "query_failed");
      if (!data.configured) {
        setQueryResults([]);
        setQueryStatus({ type: "error", message: L("订单查询暂时不可用，请联系在线客服查询", "Order lookup is temporarily unavailable — please contact support") });
        return;
      }
      if (data.verificationRequired) {
        setQueryResults([]);
        setQueryDetailOrder(null);
        setQueryVerification({ query: value, emailHint: data.emailHint || (locale === "en" ? "your order email" : "下单邮箱") });
        setQueryCode("");
        setQueryStatus({
          type: "info",
          message: L(`验证码已发送至 ${data.emailHint || "下单邮箱"}，请输入 6 位验证码继续查询`, `A code was sent to ${data.emailHint || "your order email"}. Enter the 6-digit code to continue.`),
        });
        return;
      }
      const orders = data.orders || [];
      setQueryResults(orders);
      setQueryVerification(null);
      setQueryCode("");
      const orderIdMatch = orders.find((o) => o.matchType === "orderId");
      if (orderIdMatch) setQueryDetailOrder(orderIdMatch);
      setQueryStatus({
        type: orders.length ? "success" : "error",
        message: orders.length
          ? orderIdMatch ? L("已通过订单号查询到订单", "Found your order by order ID") : L(`已找到 ${orders.length} 条订单,点击查看详情`, `Found ${orders.length} order(s) — tap to view details`)
          : L("未查询到订单,请核对订单号或邮箱", "No orders found — check the order ID or email"),
      });
    } catch (error) {
      setQueryResults([]);
      const message = String(error?.message || "");
      setQueryStatus({
        type: "error",
        message: message === "code_invalid_or_expired"
          ? L("验证码错误或已过期，请重新获取", "Code is wrong or expired — please request a new one")
          : message === "invalid_query"
          ? L("请输入完整订单号或下单邮箱", "Enter your full order ID or order email")
          : L("查询失败，请稍后再试或联系在线客服", "Lookup failed — please try again or contact support"),
      });
    } finally {
      setQueryLoading(false);
    }
  }

  function submitQuery(event) {
    event.preventDefault();
    const sameQuery = queryVerification?.query && queryVerification.query === queryInput.trim();
    if (sameQuery && queryCode.trim()) runQuery(queryInput, queryCode.trim());
    else runQuery(queryInput);
  }

  function handleCopy(value, key) {
    copyText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(""), 1600);
  }

  const queryItems = useMemo(() => {
    if (!queryDetailOrder) return [];
    return Array.isArray(queryDetailOrder.items) && queryDetailOrder.items.length
      ? queryDetailOrder.items
      : [{
          service: queryDetailOrder.service,
          label: queryDetailOrder.serviceLabel,
          cycle: queryDetailOrder.cycle,
          amount: queryDetailOrder.finalAmount,
          account: queryDetailOrder.account,
          password: queryDetailOrder.password,
        }];
  }, [queryDetailOrder]);

  return (
    <div className="page-shell service-page-shell">
      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="brand-wrap" aria-label={L("返回首页", "Back home")}>
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <nav className="desktop-nav">
            <Link href="/shop">{L("服务产品", "Services")}</Link>
            <Link href="/#layout">{L("下单流程", "How it works")}</Link>
            <Link href="#order-query">{L("订单查询", "Track order")}</Link>
            <Link href="/legal">{L("企业保障", "Guarantees")}</Link>
            <Link href="#faq">FAQ</Link>
          </nav>
        </div>
      </header>

      <main className="main-content service-main">
        <section className="section container service-title-section">
          <Link href="/" className="shop-back-link"><ArrowLeft size={14} />{L("返回首页", "Home")}</Link>
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">{L("服务中心", "Service Center")}</div>
              <h1 className="section-title">{L("服务中心", "Service Center")}</h1>
              <p className="section-note">{L("订单查询、售后支持与在线客服", "Order lookup & live support")}</p>
            </div>
          </div>
        </section>

        <section className="section container service-tools-section">
          <div className="service-single-column">
            <div id="order-query" className="query-pair-block order-query-section">
              <div className="section-head simple-head">
                <div>
                  <div className="section-kicker">{L("订单查询", "Track order")}</div>
                  <h2 className="section-title">{L("订单查询", "Track order")}</h2>
                </div>
              </div>
              <div className="order-query-panel">
                <form className={`order-query-form ${queryVerification ? "is-verifying" : ""}`} onSubmit={submitQuery}>
                  <label className="order-query-field">
                    <span>{L("完整订单号 / 下单邮箱", "Full order number / order email")}</span>
                    <input
                      value={queryInput}
                      onChange={(e) => {
                        setQueryInput(e.target.value);
                        if (queryVerification && e.target.value.trim() !== queryVerification.query) {
                          setQueryVerification(null);
                          setQueryCode("");
                        }
                      }}
                      placeholder={L("输入完整订单号或下单时填写的邮箱", "Enter your full order number or order email")}
                      autoComplete="off"
                    />
                  </label>
                  {queryVerification && (
                    <div className="order-query-verification">
                      <div className="order-query-verify-copy">
                        <span><Lock size={14} /> {L("邮箱核验", "Email verification")}</span>
                        <strong>{L("验证码已发送至", "Code sent to")} {queryVerification.emailHint || L("下单邮箱", "your order email")}</strong>
                        <small>{L("输入 6 位数字后查看订单详情", "Enter the 6-digit code to view order details")}</small>
                      </div>
                      <label className="order-query-code-input">
                        <span>{L("验证码", "Code")}</span>
                        <input
                          value={queryCode}
                          onChange={(e) => setQueryCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          placeholder="000000"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          aria-label={L("邮箱验证码", "Email code")}
                        />
                      </label>
                      <button type="submit" className="primary-btn order-query-verify-btn" disabled={queryLoading}>
                        {queryLoading ? <LoaderCircle size={15} className="spin-icon" /> : <Search size={16} />}
                        {L("验证查询", "Verify & search")}
                      </button>
                    </div>
                  )}
                  {!queryVerification && (
                    <button type="submit" className="primary-btn" disabled={queryLoading}>
                      {queryLoading ? <LoaderCircle size={15} className="spin-icon" /> : <Search size={16} />}
                      {L("查询订单", "Search order")}
                    </button>
                  )}
                </form>
                {queryStatus && (!queryVerification || queryStatus.type !== "info") && (
                  <div className={`query-status ${queryStatus.type}`}>{queryStatus.message}</div>
                )}
                {queryResults.length > 0 && (
                  <div className="query-results-compact">
                    {queryResults.map((order) => (
                      <button key={order.orderId} type="button" className="query-result-row" onClick={() => setQueryDetailOrder(order)}>
                        <div className="query-result-row-main">
                          <strong>{order.serviceLabel || L("订单", "Order")}</strong>
                          <span>{order.email}</span>
                        </div>
                        <div className="query-result-row-meta">
                          <span>{statusLabel[order.status] || order.status}</span>
                          <b>¥{Number(order.finalAmount || order.paidAmount || 0).toFixed(2)}</b>
                        </div>
                        <ArrowRight size={14} className="query-result-row-arrow" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

          </div>
        </section>

        <section id="assurance" className="section container assurance-section">
          <div className="section-head simple-head assurance-head">
            <div>
              <div className="section-kicker">{L("服务保障", "Assurance")}</div>
              <h2 className="section-title">{L("服务保障体系", "Our service assurance")}</h2>
            </div>
          </div>
          <div className="assurance-grid">
            {assuranceCards.map(({ title, desc, meta, icon: Icon }) => (
              <article key={title} className="glass-card assurance-card">
                <div className="assurance-card-title">
                  <span className="assurance-card-icon"><Icon size={18} /></span>
                  {title}
                </div>
                <p>{desc}</p>
                <small>{meta}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="section container contact-section">
          <div className="faq-contact-pair">
            <div id="faq" className="faq-pair-block">
              <div className="section-head simple-head">
                <div>
                  <div className="section-kicker">{L("常见问题", "FAQ")}</div>
                  <h2 className="section-title">{L("常见问题", "FAQ")}</h2>
                </div>
              </div>
              <div className="faq-list">
                {faqList.map((faq, index) => {
                  const open = faqOpen === index;
                  return (
                    <div key={faq.q} className={`faq-card${open ? " faq-open" : ""}`}>
                      <button className="faq-button" onClick={() => setFaqOpen(open ? -1 : index)} aria-expanded={open} aria-controls={`faq-panel-${index}`}>
                        {faq.q}
                        <ChevronDown size={18} className={`chevron${open ? " rotate" : ""}`} />
                      </button>
                      {open && <div className="faq-answer" id={`faq-panel-${index}`} role="region">{faq.a}</div>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div id="contact" className="contact-pair-block">
              <div className="section-head simple-head">
                <div>
                  <div className="section-kicker">{L("在线联系", "Get in touch")}</div>
                  <h2 className="section-title">{L("联系我们", "Contact us")}</h2>
                </div>
              </div>
              <div className="channels-grid channels-row">
                {SUPPORT_CHANNELS.map((ch) => {
                  const kind = ch.label.toLowerCase();
                  const BrandIcon = kind === "qq" ? QQBrandIcon : kind === "whatsapp" ? WhatsAppBrandIcon : TelegramBrandIcon;
                  return (
                    <div key={ch.label} className="glass-card channel-card">
                      <span className={`channel-icon-wrap ${kind}`} aria-hidden="true"><BrandIcon /></span>
                      <div className="channel-label">{ch.label}</div>
                      <div className="channel-value">{ch.value}</div>
                      <button
                        className={`channel-copy-btn${copiedKey === ch.label ? " copied" : ""}`}
                        onClick={() => handleCopy(ch.copyValue, ch.label)}
                      >
                        <Copy size={14} />{copiedKey === ch.label ? L("已复制", "Copied") : L("复制", "Copy")}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer service-footer">
        <div className="container footer-inner">
          <div className="footer-company">
            <div className="footer-brand">{L("冒央会社 · Maoyang Taiwan Inc", "Maoyang Taiwan Inc")}</div>
            <div className="footer-links">
              <Link href="/legal">{L("企业资质与服务保障", "Credentials & service assurance")}</Link>
              <Link href="/services/spotify">Spotify</Link>
              <Link href="/services/netflix">Netflix</Link>
              <Link href="/services/disney">Disney+</Link>
              <Link href="/services/hbo-max">HBO Max</Link>
              <Link href="/services/airport-node">{L("机场节点", "VPN")}</Link>
            </div>
          </div>
          <div className="footer-legal">
            <div className="footer-pill">{L("地址：台湾新北市板桥区远东路1号3-218", "Addr: 3-218, No.1 Yuandong Rd, Banqiao, New Taipei, Taiwan")}</div>
            <div className="footer-pill">Copyright © 2020-2026 Maoyang Taiwan Inc. All rights reserved</div>
          </div>
        </div>
      </footer>

      <FloatingSupport />
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
                  <div className="auth-divider"><span>{L("或使用", "or")}</span></div>
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

      {queryDetailOrder && (
        <div className="modal-mask" onClick={() => setQueryDetailOrder(null)}>
          <div className="query-modal" onClick={(e) => e.stopPropagation()}>
            <div className="query-modal-head">
              <div>
                <div className="section-kicker">{L("订单详情", "Order details")}</div>
                <div className="query-modal-title">{L("订单详情", "Order details")}</div>
                <code className="query-modal-id">{queryDetailOrder.orderId}</code>
                <div className={`query-modal-status status-${queryDetailOrder.status || "received"}`}>
                  {statusLabel[queryDetailOrder.status] || queryDetailOrder.status}
                </div>
              </div>
              <button className="close-btn" onClick={() => setQueryDetailOrder(null)} aria-label={L("关闭", "Close")}><X size={20} /></button>
            </div>
            <div className="query-modal-body">
              <div className="query-modal-amount">
                <span>{L("实付金额", "Amount paid")}</span>
                <b>{queryDetailOrder.paidCurrency === "USDT" ? `${queryDetailOrder.paidAmount} USDT` : queryDetailOrder.paidCurrency === "CODE" ? L("服务兑换码", "Service code") : `¥${Number(queryDetailOrder.paidAmount || queryDetailOrder.finalAmount || 0).toFixed(2)}`}</b>
                <em>{paymentLabel(queryDetailOrder, locale)}</em>
              </div>
              <div className="query-modal-items">
                <div className="query-modal-items-label">{L("商品明细", "Items")} · {queryItems.length}</div>
                {queryItems.map((item, idx) => (
                  <div key={idx} className="query-modal-item">
                    <div className="query-modal-item-head">
                      <strong>{item.label || L("订单商品", "Item")}</strong>
                      <span>¥{Number(item.amount || 0).toFixed(2)}</span>
                    </div>
                    {(item.account || item.password) && (
                      <div className="query-modal-item-creds">
                        {item.account && <div><span>{item.service === "rocket" ? L("用户名", "Username") : L("账号", "Account")}</span><code>{item.account}</code></div>}
                        {item.password && <div><span>{L("密码", "Password")}</span><code>{item.password}</code></div>}
                      </div>
                    )}
                    {item.subscriptionLinks && (
                      <div className="query-modal-item-subs">
                        <button className="query-modal-sub-row" onClick={() => handleCopy(item.subscriptionLinks.shadowrocket, `sr-${idx}`)}>
                          <span>Shadowrocket</span><small>{item.subscriptionLinks.shadowrocket}</small><em>{copiedKey === `sr-${idx}` ? L("已复制", "Copied") : L("复制", "Copy")}</em>
                        </button>
                        <button className="query-modal-sub-row" onClick={() => handleCopy(item.subscriptionLinks.clash, `cl-${idx}`)}>
                          <span>Clash</span><small>{item.subscriptionLinks.clash}</small><em>{copiedKey === `cl-${idx}` ? L("已复制", "Copied") : L("复制", "Copy")}</em>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {queryDetailOrder.staffNotes && (
                <div className="query-modal-staff-notes">
                  <div className="query-modal-staff-notes-label">{L("客服备注", "Support note")}</div>
                  <div>{queryDetailOrder.staffNotes}</div>
                </div>
              )}
              <div className="query-modal-rows">
                <div><span>{L("下单时间", "Ordered at")}</span><b>{queryDetailOrder.createdAtBeijing || "--"}</b></div>
                <div><span>{L("完成时间", "Completed at")}</span><b>{queryDetailOrder.completedAtBeijing || "--"}</b></div>
                <div><span>{L("邮箱", "Email")}</span><b>{queryDetailOrder.email || "--"}</b></div>
                <div><span>{L("联系方式", "Contact")}</span><b>{queryDetailOrder.contact || "--"}</b></div>
                {queryDetailOrder.remark && <div className="query-modal-row-wide"><span>{L("备注", "Note")}</span><b className="query-modal-remark">{queryDetailOrder.remark}</b></div>}
              </div>
            </div>
          </div>
        </div>
      )}

      <MobileNav />
    </div>
  );
}
