"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  Clipboard,
  Clock3,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MailCheck,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import MobileNav from "../components/MobileNav";
import { useLocale } from "../components/LocaleProvider";
import styles from "./netflix-code.module.css";

const RESULT_POLL_MS = 6000;
const RESULT_POLL_LIMIT = 15;
const RESULT_DELAY_NOTICE_AT = 5;

function hasNetflix(order) {
  return (Array.isArray(order?.items) ? order.items : []).some((item) => item?.service === "netflix");
}

function eligibleOrder(order) {
  return hasNetflix(order) && ["received", "completed"].includes(order?.status);
}

function compactOrderId(value) {
  const id = String(value || "");
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export default function NetflixCodePage() {
  const { locale } = useLocale();
  const en = locale === "en";
  const L = useCallback((zh, english) => (en ? english : zh), [en]);
  const pollTimer = useRef(null);
  const pollCount = useRef(0);
  const sessionRef = useRef("");

  const [loadingAccount, setLoadingAccount] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [orders, setOrders] = useState([]);
  const [query, setQuery] = useState("");
  const [verification, setVerification] = useState(null);
  const [code, setCode] = useState("");
  const [queryBusy, setQueryBusy] = useState(false);
  const [authorizing, setAuthorizing] = useState("");
  const [session, setSession] = useState(null);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState(null);
  const [retrieving, setRetrieving] = useState(false);
  const [copied, setCopied] = useState(false);

  const availableOrders = useMemo(() => orders.filter(eligibleOrder), [orders]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
    pollCount.current = 0;
    setRetrieving(false);
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => ({ response, data: await response.json() }))
      .then(({ response, data }) => {
        if (!alive) return;
        if (response.ok && data?.ok) {
          setLoggedIn(true);
          setOrders(Array.isArray(data.orders) ? data.orders : []);
        }
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoadingAccount(false); });
    return () => {
      alive = false;
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
  }, []);

  function errorCopy(error) {
    return ({
      verification_required: L("请先核验订单身份", "Verify the order first"),
      order_not_found: L("未找到该订单", "Order not found"),
      order_not_eligible: L("仅已收到或已完成的 Netflix 订单可使用", "Only received or completed Netflix orders are eligible"),
      netflix_order_required: L("该订单不包含 Netflix 服务", "This order does not include Netflix"),
      netflix_account_missing: L("订单尚未交付 Netflix 登录邮箱，请稍后再试", "The Netflix sign-in email has not been assigned yet"),
      self_service_disabled: L("此订单暂时无法在线获取登录码，请联系在线客服", "Online sign-in codes are unavailable for this order; contact support"),
      service_expired: L("该订单服务期已结束", "This order has expired"),
      session_expired: L("本次核验已过期，请重新选择订单", "This verification has expired; select the order again"),
      temporarily_locked: L("操作较频繁，请 15 分钟后再试", "Too many attempts; try again in 15 minutes"),
      service_not_configured: L("登录码服务暂时不可用，请稍后再试", "The sign-in code service is temporarily unavailable; try again later"),
      mail_unrecognized: L("已收到邮件，但未识别到可用的 4 位登录码。请在 Netflix 重新发送后再试", "The email arrived, but no valid 4-digit sign-in code was found. Request a new email from Netflix and try again"),
    })[error] || L("暂时无法完成，请稍后再试", "Unable to complete this request right now");
  }

  async function submitQuery(event) {
    event.preventDefault();
    if (!query.trim() || queryBusy) return;
    setQueryBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/order-query", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), code: verification ? code : "" }),
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        const message = data?.error === "code_invalid_or_expired"
          ? L("验证码错误或已过期", "The verification code is incorrect or expired")
          : L("订单核验失败，请检查后重试", "Order verification failed; check the details and retry");
        throw new Error(message);
      }
      if (data.verificationRequired) {
        setVerification({ query: query.trim(), emailHint: data.emailHint || "" });
        setCode("");
        setStatus({ type: "info", text: L("验证邮件已发送，请查收", "Check your inbox for the verification email") });
        return;
      }
      const matched = (Array.isArray(data.orders) ? data.orders : []).filter(eligibleOrder);
      setOrders(matched);
      setVerification(null);
      setCode("");
      setStatus(matched.length
        ? { type: "success", text: L("订单身份已核验", "Order verified") }
        : { type: "error", text: L("未找到可使用的 Netflix 订单", "No eligible Netflix order was found") });
    } catch (error) {
      setStatus({ type: "error", text: error?.message || L("订单核验失败", "Order verification failed") });
    } finally {
      setQueryBusy(false);
    }
  }

  async function authorize(order) {
    if (!order?.orderId || authorizing) return;
    stopPolling();
    setAuthorizing(order.orderId);
    setResult(null);
    setStatus(null);
    try {
      const response = await fetch("/api/netflix-code", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "authorize", orderId: order.orderId, token: order.afterSalesToken || "" }),
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) throw new Error(errorCopy(data?.error));
      sessionRef.current = data.sessionToken;
      setSession({
        token: data.sessionToken,
        orderId: data.orderId,
        account: data.netflixAccount,
        accountHint: data.accountHint,
      });
    } catch (error) {
      setStatus({ type: "error", text: error?.message || L("无法核验该订单", "Unable to verify this order") });
    } finally {
      setAuthorizing("");
    }
  }

  const retrieveResult = useCallback(async () => {
    const token = sessionRef.current;
    if (!token) return;
    try {
      const response = await fetch("/api/netflix-code", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retrieve", sessionToken: token }),
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) throw new Error(errorCopy(data?.error));
      if (data.kind === "code" || data.kind === "link") {
        stopPolling();
        setResult(data);
        setStatus(null);
        return;
      }
      pollCount.current += 1;
      if (pollCount.current >= RESULT_POLL_LIMIT) {
        stopPolling();
        setStatus({ type: "info", text: L("暂未收到邮件。请确认 Netflix 已显示发送成功，稍后再试。", "No email yet. Make sure Netflix confirmed it was sent, then try again.") });
        return;
      }
      setStatus({
        type: "info",
        text: pollCount.current >= RESULT_DELAY_NOTICE_AT
          ? L("邮件可能仍在转发中，请稍候。", "Your email may still be forwarding. Please wait.")
          : L("正在接收 Netflix 邮件…", "Waiting for your Netflix email…"),
      });
      pollTimer.current = window.setTimeout(retrieveResult, RESULT_POLL_MS);
    } catch (error) {
      stopPolling();
      setStatus({ type: "error", text: error?.message || L("读取失败，请稍后再试", "Retrieval failed; try again later") });
    }
  }, [L, stopPolling]);

  function beginRetrieve() {
    if (!session?.token || retrieving) return;
    stopPolling();
    pollCount.current = 0;
    setResult(null);
    setRetrieving(true);
    setStatus({ type: "info", text: L("正在接收 Netflix 邮件…", "Waiting for your Netflix email…") });
    retrieveResult();
  }

  async function copyAccount() {
    try {
      await navigator.clipboard.writeText(session?.account || "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  function resetSession() {
    stopPolling();
    sessionRef.current = "";
    setSession(null);
    setResult(null);
    setStatus(null);
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" aria-label={L("返回首页", "Back home")}><img src="/logo-transparent.png" alt="冒央会社" /></Link>
        <Link href="/service-center"><ArrowLeft size={15} />{L("服务中心", "Service Center")}</Link>
      </header>

      <main className={styles.main}>
        <section className={styles.intro}>
          <span><KeyRound size={15} />{L("NETFLIX 登录帮助", "NETFLIX SIGN-IN")}</span>
          <h1>{L("获取 Netflix 登录码", "Get your Netflix sign-in code")}</h1>
          <p>{L("先在 Netflix 输入订单提供的登录邮箱并发送登录码，再回到这里读取。", "Enter the Netflix sign-in email provided with your order, request a code, then return here to retrieve it.")}</p>
          <div className={styles.introSteps} aria-label={L("使用步骤", "Steps")}>
            <span><b>1</b>{L("确认订单", "Verify order")}</span>
            <span><b>2</b>{L("发送登录码", "Request on Netflix")}</span>
            <span><b>3</b>{L("读取登录码", "Return for code")}</span>
          </div>
        </section>

        {!session ? (
          <section className={styles.verify} aria-labelledby="verify-title">
            <div className={styles.sectionTitle}>
              <span>01</span>
              <div><h2 id="verify-title">{L("先确认您的订单", "First, verify your order")}</h2><p>{L("登录后可直接选择；未登录可使用订单号或下单邮箱验证。", "Sign in to select an order, or verify with the order number or email.")}</p></div>
            </div>

            {loadingAccount ? (
              <div className={styles.loading}><LoaderCircle className="spin-icon" size={18} />{L("正在读取订单…", "Loading orders…")}</div>
            ) : availableOrders.length ? (
              <div className={styles.orderList}>
                {availableOrders.map((order) => (
                  <button type="button" key={order.orderId} onClick={() => authorize(order)} disabled={Boolean(authorizing)}>
                    <span><b>{order.serviceLabel || "Netflix"}</b><small>{compactOrderId(order.orderId)} · {order.createdAtBeijing || ""}</small></span>
                    <em>{authorizing === order.orderId ? <LoaderCircle className="spin-icon" size={16} /> : L("选择", "Select")}</em>
                  </button>
                ))}
              </div>
            ) : (
              <form className={styles.queryForm} onSubmit={submitQuery}>
                <label>
                  <span>{L("订单号或下单邮箱", "Order number or order email")}</span>
                  <div><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); if (verification && event.target.value.trim() !== verification.query) { setVerification(null); setCode(""); } }} placeholder={L("输入订单号或邮箱", "Enter order number or email")} autoComplete="off" /></div>
                </label>
                {verification && (
                  <label>
                    <span>{L(`输入 ${verification.emailHint} 收到的 6 位订单验证码`, `Enter the 6-digit order code sent to ${verification.emailHint}`)}</span>
                    <div><LockKeyhole size={16} /><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></div>
                  </label>
                )}
                <button type="submit" disabled={queryBusy || !query.trim() || (verification && code.length !== 6)}>
                  {queryBusy ? <LoaderCircle className="spin-icon" size={16} /> : <MailCheck size={16} />}
                  {verification ? L("确认订单", "Verify order") : L("继续", "Continue")}
                </button>
                {!loggedIn && <p className={styles.loginHint}>{L("已有账号？", "Have an account?")} <Link href="/account">{L("登录后直接选择订单", "Sign in to select your order")}</Link></p>}
              </form>
            )}
          </section>
        ) : (
          <section className={styles.workspace} aria-labelledby="workspace-title">
            <div className={styles.sectionTitle}>
              <span>02</span>
              <div><h2 id="workspace-title">{L("前往 Netflix 发送登录码", "Request a code on Netflix")}</h2><p>{L("按下面三步完成登录。", "Follow these three steps to sign in.")}</p></div>
              <button type="button" onClick={resetSession}>{L("其他订单", "Other order")}</button>
            </div>

            <div className={styles.accountRow}>
              <span>{L("Netflix 登录邮箱", "Netflix sign-in email")}</span>
              <strong>{session.account}</strong>
              <button type="button" onClick={copyAccount}>{copied ? <Check size={15} /> : <Clipboard size={15} />}{copied ? L("已复制", "Copied") : L("复制", "Copy")}</button>
            </div>

            <ol className={styles.steps}>
              <li><span>1</span><div><b>{L("复制登录邮箱", "Copy the sign-in email")}</b><p>{L("在 Netflix 登录页输入上方邮箱。", "Enter the email above on the Netflix sign-in page.")}</p></div></li>
              <li><span>2</span><div><b>{L("让 Netflix 发送邮件", "Ask Netflix to send the email")}</b><p>{L("选择通过邮件获取登录码，并等待发送成功提示。", "Choose the email sign-in option and wait for the sent confirmation.")}</p></div></li>
              <li><span>3</span><div><b>{L("返回这里取码", "Return here for the code")}</b><p>{L("邮件发出后，点击下方按钮。", "Once sent, use the button below.")}</p></div></li>
            </ol>

            {!result && (
              <button type="button" className={styles.retrieve} onClick={beginRetrieve} disabled={retrieving}>
                {retrieving ? <LoaderCircle className="spin-icon" size={17} /> : <RefreshCw size={17} />}
                {retrieving ? L("正在接收…", "Waiting…") : L("已在 Netflix 发送，读取登录码", "Sent on Netflix · Get my code")}
              </button>
            )}

            {result?.kind === "code" && (
              <div className={styles.codeResult}>
                <span>{L("您的 Netflix 登录码", "Your Netflix sign-in code")}</span>
                <strong>{result.code}</strong>
                <p><Clock3 size={14} />{L("请尽快输入 Netflix，通常在 15 分钟内有效。", "Enter it on Netflix promptly; it is usually valid for 15 minutes.")}</p>
              </div>
            )}

            {result?.kind === "link" && (
              <div className={styles.linkResult}>
                <span>{L("请在 Netflix 完成登录确认", "Confirm this sign-in on Netflix")}</span>
                <p>{L("这封邮件没有直接显示验证码。点击下方按钮，在 Netflix 官方页面获取临时代码。", "This email does not show a code directly. Use the official Netflix page below to get your temporary code.")}</p>
                <a href={result.url} target="_blank" rel="noopener noreferrer">{L("前往 Netflix 获取临时代码", "Get the temporary code on Netflix")}<ExternalLink size={15} /></a>
                <small><Clock3 size={13} />{L("链接仅用于本次登录，请勿转发。", "This link is for this sign-in only. Do not share it.")}</small>
              </div>
            )}

            {result && <button type="button" className={styles.again} onClick={() => { setResult(null); setStatus(null); }}>{L("读取下一封邮件", "Retrieve another email")}</button>}
          </section>
        )}

        {status && <div className={`${styles.status} ${styles[status.type]}`}>{status.text}</div>}

        <footer className={styles.note}>
          <ShieldCheck size={15} />
          <p>{L("请勿向他人转发登录码或确认链接。长时间未收到邮件时，请重新在 Netflix 发送。", "Do not share your sign-in code or confirmation link. If no email arrives, request it again on Netflix.")}</p>
        </footer>
      </main>
      <MobileNav />
    </div>
  );
}
