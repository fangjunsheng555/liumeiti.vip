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
import { fetchNetflixJson } from "./fetch-json";
import { eligibleNetflixCodeOrder } from "./order-eligibility";
import styles from "./netflix-code.module.css";

const RESULT_POLL_MS = 6000;
const RESULT_POLL_LIMIT = 15;
const RESULT_DELAY_NOTICE_AT = 5;
function compactOrderId(value) {
  const id = String(value || "");
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function entryOrderIdFromLocation() {
  if (typeof window === "undefined") return "";
  const value = String(new URLSearchParams(window.location.search).get("orderId") || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
  return /^[A-Z0-9_-]{1,80}$/.test(value) ? value : "";
}

export default function NetflixCodePage() {
  const { locale } = useLocale();
  const en = locale === "en";
  const L = useCallback((zh, english) => (en ? english : zh), [en]);
  const pollTimer = useRef(null);
  const codeCopyTimer = useRef(null);
  const pollCount = useRef(0);
  const sessionRef = useRef("");
  const resultPanelRef = useRef(null);
  const retrieveButtonRef = useRef(null);
  const authorizingRef = useRef("");
  const resumedEntryRef = useRef("");
  // Rejected mail events already shown to the user. Sending them back lets the
  // server wait for a fresh email instead of replaying the same failure.
  const seenRejectedRef = useRef([]);

  const [loadingAccount, setLoadingAccount] = useState(true);
  const [accountLoadError, setAccountLoadError] = useState("");
  const [accountLoadAttempt, setAccountLoadAttempt] = useState(0);
  const [entryOrderId, setEntryOrderId] = useState("");
  const [entryResumeAttempt, setEntryResumeAttempt] = useState(0);
  const [entryNeedsVerification, setEntryNeedsVerification] = useState(false);
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
  const [codeCopyState, setCodeCopyState] = useState("idle");

  const availableOrders = useMemo(() => orders.filter(eligibleNetflixCodeOrder), [orders]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
    pollCount.current = 0;
    setRetrieving(false);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoadingAccount(true);
    setAccountLoadError("");
    setLoggedIn(false);
    setOrders([]);
    fetchNetflixJson("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
      .then(({ response, data }) => {
        if (!alive) return;
        if (response.ok && data?.ok) {
          setLoggedIn(true);
          setOrders(Array.isArray(data.orders) ? data.orders : []);
          return;
        }
        if (response.status === 401) return;
        throw new Error(L("账号订单暂时无法读取，请重试", "Account orders could not be loaded; please retry"));
      })
      .catch((error) => {
        if (!alive) return;
        setAccountLoadError(error?.name === "AbortError"
          ? L("读取账号订单超时，请重试", "Loading account orders timed out; please retry")
          : L("账号订单暂时无法读取，请重试", "Account orders could not be loaded; please retry"));
      })
      .finally(() => { if (alive) setLoadingAccount(false); });
    return () => {
      alive = false;
    };
  }, [accountLoadAttempt, L]);

  useEffect(() => () => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    if (codeCopyTimer.current) window.clearTimeout(codeCopyTimer.current);
  }, []);

  useEffect(() => {
    const orderId = entryOrderIdFromLocation();
    if (!orderId) return;
    setEntryOrderId(orderId);
    setQuery(orderId);
  }, []);

  useEffect(() => {
    if (!result) return undefined;
    const frame = window.requestAnimationFrame(() => resultPanelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [result]);

  const errorCopy = useCallback((error) => ({
      verification_required: L("请先核验订单身份", "Verify the order first"),
      order_not_found: L("未找到该订单", "Order not found"),
      order_not_eligible: L("仅已收到或已完成的 Netflix 订单可使用", "Only received or completed Netflix orders are eligible"),
      netflix_order_required: L("该订单不包含 Netflix 服务", "This order does not include Netflix"),
      netflix_account_missing: L("订单尚未交付 Netflix 登录邮箱，请稍后再试", "The Netflix sign-in email has not been assigned yet"),
      netflix_account_conflict: L("该订单包含多个 Netflix 登录邮箱，请联系在线客服", "This order contains multiple Netflix sign-in emails; contact support"),
      self_service_disabled: L("此订单暂时无法在线获取登录码，请联系在线客服", "Online sign-in codes are unavailable for this order; contact support"),
      service_expired: L("该订单服务期已结束", "This order has expired"),
      session_expired: L("本次核验已过期，请重新选择订单", "This verification has expired; select the order again"),
      temporarily_locked: L("操作较频繁，请 15 分钟后再试", "Too many attempts; try again in 15 minutes"),
      service_not_configured: L("登录码服务暂时不可用，请稍后再试", "The sign-in code service is temporarily unavailable; try again later"),
      mail_unrecognized: L("已收到邮件，但未识别到可用的登录码或确认链接。请在 Netflix 重新发送后，再点击一次读取", "The email arrived, but no usable sign-in code or confirmation link was found. Request a new email from Netflix, then tap retrieve again"),
    })[error] || L("暂时无法完成，请稍后再试", "Unable to complete this request right now"), [L]);

  async function submitQuery(event) {
    event.preventDefault();
    if (!query.trim() || queryBusy) return;
    setQueryBusy(true);
    setStatus(null);
    try {
      const { response, data } = await fetchNetflixJson("/api/order-query", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), code: verification ? code : "" }),
      });
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
      const matched = (Array.isArray(data.orders) ? data.orders : []).filter(eligibleNetflixCodeOrder);
      setOrders(matched);
      setEntryNeedsVerification(false);
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

  const authorize = useCallback(async (order, { fromVerifiedLink = false } = {}) => {
    const orderId = String(order?.orderId || "").trim().replace(/\s+/g, "").toUpperCase();
    if (!orderId || authorizingRef.current) return;
    authorizingRef.current = orderId;
    stopPolling();
    if (fromVerifiedLink) setEntryNeedsVerification(true);
    setAuthorizing(orderId);
    setResult(null);
    setStatus(fromVerifiedLink
      ? { type: "info", text: L("正在沿用刚才的订单核验…", "Reusing your recent order verification…") }
      : null);
    let responseStatus = 0;
    try {
      const { response, data } = await fetchNetflixJson("/api/netflix-code", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "authorize", orderId, token: order.afterSalesToken || "" }),
      });
      responseStatus = response.status;
      if (!response.ok || !data?.ok) {
        if (fromVerifiedLink && data?.error === "verification_required") {
          setQuery(orderId);
          setStatus({
            type: "info",
            text: L("刚才的身份核验已过期。点击“继续”后再接收一次验证码。", "Your recent verification has expired. Select Continue to receive a new code."),
          });
          return;
        }
        throw new Error(errorCopy(data?.error));
      }
      sessionRef.current = data.sessionToken;
      setSession({
        token: data.sessionToken,
        orderId: data.orderId,
        account: data.netflixAccount,
        accountHint: data.accountHint,
      });
      setEntryNeedsVerification(false);
      setStatus(null);
    } catch (error) {
      setStatus({
        type: "error",
        text: error?.message || L("无法核验该订单", "Unable to verify this order"),
        retryEntry: fromVerifiedLink && (responseStatus === 0 || responseStatus === 429 || responseStatus >= 500),
      });
    } finally {
      authorizingRef.current = "";
      setAuthorizing("");
    }
  }, [L, errorCopy, stopPolling]);

  useEffect(() => {
    if (!entryOrderId || session) return;
    const attemptKey = `${entryOrderId}:${entryResumeAttempt}`;
    if (resumedEntryRef.current === attemptKey) return;
    resumedEntryRef.current = attemptKey;
    void authorize({ orderId: entryOrderId }, { fromVerifiedLink: true });
  }, [authorize, entryOrderId, entryResumeAttempt, session]);

  const retrieveResult = useCallback(async () => {
    const token = sessionRef.current;
    if (!token) return;
    try {
      const { response, data } = await fetchNetflixJson("/api/netflix-code", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retrieve", sessionToken: token, seenEventIds: seenRejectedRef.current }),
      });
      if (!response.ok || !data?.ok) {
        if (data?.error === "mail_unrecognized") {
          const rejectedIds = [...(Array.isArray(data.eventIds) ? data.eventIds : []), data.eventId]
            .filter((value) => typeof value === "string" && value);
          seenRejectedRef.current = Array.from(new Set([...seenRejectedRef.current, ...rejectedIds])).slice(-12);
        }
        throw new Error(errorCopy(data?.error));
      }
      if (data.kind === "code" || data.kind === "link" || data.kind === "household") {
        stopPolling();
        setCodeCopyState("idle");
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
        text: data.mailReceived
          ? L("邮件已到达，正在读取登录码…", "Your email arrived. Reading the sign-in code…")
          : pollCount.current >= RESULT_DELAY_NOTICE_AT
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

  async function copyResultCode() {
    const value = String(result?.code || "").trim();
    if (!value) return;
    if (codeCopyTimer.current) window.clearTimeout(codeCopyTimer.current);
    try {
      await navigator.clipboard.writeText(value);
      setCodeCopyState("copied");
    } catch {
      setCodeCopyState("error");
    }
    codeCopyTimer.current = window.setTimeout(() => setCodeCopyState("idle"), 2500);
  }

  function retrieveAnotherEmail() {
    setResult(null);
    setStatus(null);
    setCodeCopyState("idle");
    window.requestAnimationFrame(() => retrieveButtonRef.current?.focus());
  }

  function resetSession() {
    stopPolling();
    sessionRef.current = "";
    seenRejectedRef.current = [];
    setSession(null);
    setResult(null);
    setStatus(null);
    setCodeCopyState("idle");
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
            ) : (
              <>
                {accountLoadError && (
                  <div className={styles.accountLoadError} role="alert">
                    <p>{accountLoadError}</p>
                    <button type="button" onClick={() => setAccountLoadAttempt((value) => value + 1)}>
                      <RefreshCw size={15} />{L("重试读取账号", "Retry account loading")}
                    </button>
                  </div>
                )}
                {availableOrders.length && !entryNeedsVerification ? (
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
                    <button type="submit" disabled={queryBusy || Boolean(authorizing) || !query.trim() || (verification && code.length !== 6)}>
                      {queryBusy || authorizing ? <LoaderCircle className="spin-icon" size={16} /> : <MailCheck size={16} />}
                      {authorizing ? L("正在确认…", "Verifying…") : verification ? L("确认订单", "Verify order") : L("继续", "Continue")}
                    </button>
                    {!loggedIn && <p className={styles.loginHint}>{L("已有账号？", "Have an account?")} <Link href="/account?auth=login&returnTo=%2Fnetflix-code">{L("登录后直接选择订单", "Sign in to select your order")}</Link></p>}
                  </form>
                )}
              </>
            )}
          </section>
        ) : (
          <section className={styles.workspace} aria-labelledby="workspace-title" aria-busy={retrieving}>
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
              <button ref={retrieveButtonRef} type="button" className={styles.retrieve} onClick={beginRetrieve} disabled={retrieving}>
                {retrieving ? <LoaderCircle className="spin-icon" size={17} /> : <RefreshCw size={17} />}
                {retrieving ? L("正在接收…", "Waiting…") : L("已在 Netflix 发送，读取登录码", "Sent on Netflix · Get my code")}
              </button>
            )}

            {result?.kind === "code" && (
              <section ref={resultPanelRef} tabIndex={-1} className={`${styles.resultPanel} ${styles.codeResult}`} aria-labelledby="netflix-code-result-title">
                <div className={styles.resultHeading}>
                  <span className={styles.resultIcon} aria-hidden="true"><Check size={18} strokeWidth={3} /></span>
                  <div>
                    <p>{L("登录码已读取", "Sign-in code retrieved")}</p>
                    <h3 id="netflix-code-result-title">{L("您的 Netflix 登录码", "Your Netflix sign-in code")}</h3>
                  </div>
                </div>

                <div className={styles.codeSurface}>
                  <output tabIndex={0} aria-label={L(`Netflix 登录码 ${result.code}`, `Netflix sign-in code ${result.code}`)}>{result.code}</output>
                  <span>{L("4 位登录码", "4-digit sign-in code")}</span>
                </div>

                <p className={styles.copyFeedback} data-state={codeCopyState} role="status" aria-live="polite">
                  {codeCopyState === "copied"
                    ? L("已复制，可返回 Netflix 粘贴", "Copied. Return to Netflix and paste it")
                    : codeCopyState === "error"
                    ? L("复制失败，请选中上方登录码手动复制", "Copy failed. Select the code above to copy it manually")
                    : "\u00a0"}
                </p>

                <div className={styles.resultDetails}>
                  <p><Clock3 size={16} /><span><b>{L("请尽快使用", "Use it promptly")}</b>{L("Netflix 登录码通常在 15 分钟内有效。", "Netflix sign-in codes are usually valid for 15 minutes.")}</span></p>
                  <p><ShieldCheck size={16} /><span><b>{L("注意安全", "Keep it private")}</b>{L("仅在 Netflix 官方页面输入，请勿分享给他人。", "Enter it only on an official Netflix page. Do not share it.")}</span></p>
                </div>

                <div className={styles.resultActions}>
                  <button type="button" className={styles.copyCode} onClick={copyResultCode}>
                    {codeCopyState === "copied" ? <Check size={16} /> : <Clipboard size={16} />}
                    {codeCopyState === "copied" ? L("已复制登录码", "Code copied") : L("复制登录码", "Copy sign-in code")}
                  </button>
                  <button type="button" className={styles.again} onClick={retrieveAnotherEmail}><RefreshCw size={15} />{L("读取下一封邮件", "Retrieve another email")}</button>
                </div>
              </section>
            )}

            {result?.kind === "link" && (
              <section ref={resultPanelRef} tabIndex={-1} className={`${styles.resultPanel} ${styles.linkResult}`} aria-labelledby="netflix-link-result-title">
                <div className={styles.resultHeading}>
                  <span className={styles.resultIcon} aria-hidden="true"><Check size={18} strokeWidth={3} /></span>
                  <div><p>{L("确认邮件已读取", "Confirmation email retrieved")}</p><h3 id="netflix-link-result-title">{L("请在 Netflix 完成登录确认", "Confirm this sign-in on Netflix")}</h3></div>
                </div>
                <p className={styles.resultDescription}>{L("这封邮件没有直接显示验证码。请通过下方 Netflix 官方页面获取临时代码。", "This email does not show a code directly. Use the official Netflix page below to get your temporary code.")}</p>
                <div className={styles.resultActions}>
                  <a className={styles.netflixAction} href={result.url} target="_blank" rel="noopener noreferrer">{L("前往 Netflix 获取临时代码", "Get the temporary code on Netflix")}<ExternalLink size={15} /></a>
                  <button type="button" className={styles.again} onClick={retrieveAnotherEmail}><RefreshCw size={15} />{L("读取下一封邮件", "Retrieve another email")}</button>
                </div>
                <p className={styles.resultSafety}><Clock3 size={14} />{L("链接仅用于本次登录，请勿转发。", "This link is for this sign-in only. Do not share it.")}</p>
              </section>
            )}

            {result?.kind === "household" && (
              <section ref={resultPanelRef} tabIndex={-1} className={`${styles.resultPanel} ${styles.linkResult}`} aria-labelledby="netflix-household-result-title">
                <div className={styles.resultHeading}>
                  <span className={styles.resultIcon} aria-hidden="true"><Check size={18} strokeWidth={3} /></span>
                  <div><p>{L("同户确认邮件已读取", "Household confirmation retrieved")}</p><h3 id="netflix-household-result-title">{L("请在 Netflix 确认同户设备更新", "Confirm the household update on Netflix")}</h3></div>
                </div>
                <p className={styles.resultDescription}>{L("打开 Netflix 官方确认页，选择邮件中的「是的，是我本人」，再按页面提示完成确认并获取验证码。", "Open the official Netflix confirmation page, complete the “Yes, This Was Me” step, then follow Netflix's instructions to get the verification code.")}</p>
                <div className={styles.resultActions}>
                  <a className={styles.netflixAction} href={result.url} target="_blank" rel="noopener noreferrer">{L("前往 Netflix 确认本次请求", "Confirm this request on Netflix")}<ExternalLink size={15} /></a>
                  <button type="button" className={styles.again} onClick={retrieveAnotherEmail}><RefreshCw size={15} />{L("读取下一封邮件", "Retrieve another email")}</button>
                </div>
                <p className={styles.resultSafety}><Clock3 size={14} />{L("链接约 15 分钟内有效，请勿转发。", "The link expires in about 15 minutes. Do not share it.")}</p>
              </section>
            )}
          </section>
        )}

        {status && (
          <div className={`${styles.status} ${styles[status.type]}`} role={status.type === "error" ? "alert" : "status"} aria-live={status.type === "error" ? "assertive" : "polite"}>
            <span className={styles.statusIcon} aria-hidden="true">
              {status.type === "success" ? <Check size={15} /> : status.type === "info" && retrieving ? <LoaderCircle className="spin-icon" size={15} /> : "!"}
            </span>
            <div>
              <b>{status.type === "success" ? L("已完成", "Done") : status.type === "error" ? L("暂未完成", "Not completed") : retrieving ? L("正在读取邮件", "Retrieving email") : L("提示", "Notice")}</b>
              <p>{status.text}</p>
              {status.retryEntry && (
                <button type="button" className={styles.statusRetry} onClick={() => setEntryResumeAttempt((value) => value + 1)}>
                  <RefreshCw size={13} />{L("重试确认", "Retry verification")}
                </button>
              )}
            </div>
          </div>
        )}

        <footer className={styles.note}>
          <ShieldCheck size={15} />
          <p>{L("请勿向他人转发登录码或确认链接。长时间未收到邮件时，请重新在 Netflix 发送。", "Do not share your sign-in code or confirmation link. If no email arrives, request it again on Netflix.")}</p>
        </footer>
      </main>
      <MobileNav />
    </div>
  );
}
