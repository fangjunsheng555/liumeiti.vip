import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const checkout = await readFile(new URL("../app/checkout/page.jsx", import.meta.url), "utf8");
const serviceCenter = await readFile(new URL("../app/service-center/page.jsx", import.meta.url), "utf8");
const account = await readFile(new URL("../app/account/page.jsx", import.meta.url), "utf8");
const redeemCard = await readFile(new URL("../app/components/RedeemCard.jsx", import.meta.url), "utf8");
const netflix = await readFile(new URL("../app/netflix-code/page.jsx", import.meta.url), "utf8");
const netflixFetch = await readFile(new URL("../app/netflix-code/fetch-json.js", import.meta.url), "utf8");
const admin = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
const security = await readFile(new URL("../app/admin/SecurityPanel.jsx", import.meta.url), "utf8");
const pushClient = await readFile(new URL("../app/lib/push-client.js", import.meta.url), "utf8");
const pushSettings = await readFile(new URL("../app/components/PushNotificationSettings.jsx", import.meta.url), "utf8");
const emailSettings = await readFile(new URL("../app/components/EmailPreferenceSettings.jsx", import.meta.url), "utf8");
const proxyQuote = await readFile(new URL("../app/components/ProxyQuotePayment.jsx", import.meta.url), "utf8");
const preferenceForm = await readFile(new URL("../app/email/preferences/PreferenceForm.jsx", import.meta.url), "utf8");
const unsubscribeConfirmation = await readFile(new URL("../app/email/unsubscribe/UnsubscribeConfirmation.jsx", import.meta.url), "utf8");
const clientFetchSource = await readFile(new URL("../app/lib/client-fetch.js", import.meta.url), "utf8");
const { clientFetch } = await import("../app/lib/client-fetch.js");

test("shared client fetch enforces a finite deadline and keeps caller cancellation", () => {
  assert.match(clientFetchSource, /export const CLIENT_FETCH_TIMEOUT_MS = 20_000/);
  assert.match(clientFetchSource, /upstreamSignal\?\.addEventListener\?\.\("abort", relayAbort/);
  assert.match(clientFetchSource, /timedOut = true;[\s\S]*?controller\.abort\(\)[\s\S]*?rejectDeadline\(timeoutError\)/);
  assert.match(clientFetchSource, /await Promise\.race\(\[\s*fetch\(/);
  assert.match(clientFetchSource, /timeoutError\.name = "TimeoutError"/);
  assert.match(clientFetchSource, /clearTimeout\(timer\)/);
  assert.match(clientFetchSource, /export async function withClientDeadline/);
});

test("shared client fetch also bounds a response body that never resolves", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: () => new Promise(() => {}) });
  try {
    const response = await clientFetch("https://example.test/hanging-body", {}, 10);
    await assert.rejects(
      response.json(),
      (error) => error?.name === "TimeoutError" && error?.code === "response_body_timeout",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shared client fetch also exits when fetch itself never returns", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    await assert.rejects(
      clientFetch("https://example.test/hanging-request", {}, 10),
      (error) => error?.name === "TimeoutError" && error?.code === "request_timeout",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkout and service center requests cannot hold their busy states forever", () => {
  assert.match(checkout, /import \{ clientFetch as fetch(?:, isClientRequestTimeout)? \} from "\.\.\/lib\/client-fetch"/);
  assert.match(serviceCenter, /import \{ clientFetch as fetch(?:, isClientRequestTimeout)? \} from "\.\.\/lib\/client-fetch"/);
  assert.match(checkout, /refreshAccountState\(\(\) => cancelled\);\s*return \(\) => \{ cancelled = true; accountLoadRequestRef\.current \+= 1; \}/);
  assert.doesNotMatch(checkout, /\.finally\([\s\S]{0,120}setAccountReady\(true\)/);
  assert.match(checkout, /finally \{\s*setSubmitting\(false\);/);
  assert.match(serviceCenter, /finally \{\s*setQueryLoading\(false\);/);
  assert.match(serviceCenter, /finally \{\s*setAfterSalesBusy\(false\);/);
});

test("Netflix account and order lookup always leave their loading states", () => {
  assert.match(netflixFetch, /export const NETFLIX_REQUEST_TIMEOUT_MS = 15 \* 1000/);
  assert.match(netflixFetch, /const response = await fetch\([\s\S]*const data = await response\.json\(\)[\s\S]*finally \{[\s\S]*clearTimeout\(timer\)/);
  assert.match(netflix, /import \{ fetchNetflixJson \} from "\.\/fetch-json"/);
  assert.match(netflix, /fetchNetflixJson\("\/api\/auth\/me"/);
  assert.match(netflix, /\.finally\(\(\) => \{ if \(alive\) setLoadingAccount\(false\); \}\)/);
  assert.match(netflix, /setAccountLoadError\(/);
  assert.match(netflix, /setAccountLoadAttempt\(\(value\) => value \+ 1\)/);
  assert.match(netflix, /className=\{styles\.accountLoadError\} role="alert"/);
  assert.match(netflix, /accountLoadError && \([\s\S]*className=\{styles\.queryForm\}/);
  assert.match(netflix, /status\.retryEntry[\s\S]*setEntryResumeAttempt\(\(value\) => value \+ 1\)/);
  assert.match(netflix, /finally \{\s*setQueryBusy\(false\);/);
  const accountEffectStart = netflix.indexOf("useEffect(() => {");
  const nextEffectStart = netflix.indexOf("useEffect(() =>", accountEffectStart + 1);
  const accountEffect = netflix.slice(accountEffectStart, nextEffectStart);
  assert.doesNotMatch(accountEffect, /clearTimeout\(pollTimer\.current\)|clearTimeout\(codeCopyTimer\.current\)/);
  assert.match(netflix, /useEffect\(\(\) => \(\) => \{\s*if \(pollTimer\.current\) window\.clearTimeout\(pollTimer\.current\);\s*if \(codeCopyTimer\.current\) window\.clearTimeout\(codeCopyTimer\.current\);\s*\}, \[\]\);/);
});

test("admin bootstrap failures replace the spinner with a Chinese error and retry", () => {
  assert.match(admin, /const \[bootstrapError, setBootstrapError\] = useState\(""\)/);
  assert.match(admin, /setBootstrapError\(adminBootstrapErrorMessage\(e,/);
  assert.match(admin, /后台加载失败/);
  assert.match(admin, /onClick=\{retryAdminBootstrap\}/);
  assert.match(admin, /页面已停止等待/);
  assert.match(admin, /if \(!hasAdminPermissionContext\(data\.currentStaff\)\)/);
});

test("security and browser-push settings also terminate failed network loads", () => {
  assert.match(security, /const \[loadError, setLoadError\] = useState\(""\)/);
  assert.match(security, /安全设置加载失败，请检查网络后重试/);
  assert.match(security, /onClick=\{load\}><RefreshCw size=\{13\} \/>重试/);
  assert.match(security, /登录日志加载失败，请重试/);
  assert.match(security, /二维码生成失败，请复制右侧密钥或链接手动添加/);
  assert.match(pushClient, /import \{ clientFetch as fetch, withClientDeadline \} from "\.\/client-fetch\.js"/);
  assert.match(pushClient, /push_service_worker_timeout/);
  assert.match(pushClient, /push_subscription_timeout/);
});

test("a failed payment QR becomes a retryable error instead of an endless image spinner", () => {
  assert.match(proxyQuote, /onError=\{\(\) => \{ setQrError\(true\); setQrReady\(false\); setPaymentReadyAt\(0\); \}\}/);
  assert.match(proxyQuote, /收款码加载失败/);
  assert.match(proxyQuote, /setQrReloadKey\(\(value\) => value \+ 1\)/);
});

test("account notification settings never expose writable defaults after an initial load failure", () => {
  assert.match(emailSettings, /loaded: false/);
  assert.match(emailSettings, /setState\(\{ loading: false, loaded: false, saving: false, error: preferenceRequestMessage\(locale, error, "load"\)/);
  assert.match(emailSettings, /if \(!state\.loaded \|\| state\.loading \|\| state\.saving\) return/);
  assert.match(emailSettings, /if \(!state\.loaded\)[\s\S]*role="alert"[\s\S]*onClick=\{load\}[\s\S]*重试/);
  assert.match(emailSettings, /return \(\) => \{ loadRequestRef\.current \+= 1; \}/);
  assert.match(emailSettings, /error: preferenceRequestMessage\(locale, error, "save"\)/);
  for (const status of [401, 403, 409]) assert.match(emailSettings, new RegExp(`error\\?\\.status === ${status}`));
  assert.match(emailSettings, /\[500, 503\]\.includes\(error\?\.status\)/);

  assert.match(pushSettings, /const \[loadError, setLoadError\] = useState\(""\)/);
  assert.match(pushSettings, /finally \{\s*if \(requestId === loadRequestRef\.current\) setLoading\(false\);\s*\}/);
  assert.doesNotMatch(pushSettings, /currentBrowserPushSubscription\(\)\.catch\(\(\) => null\)/);
  assert.match(pushSettings, /if \(loadError \|\| !state\)[\s\S]*role="alert"[\s\S]*onClick=\{load\}[\s\S]*重试/);
  assert.doesNotMatch(pushSettings, /setState\(\{ enabled: false, configured: false, preferences: \{\}/);
});

test("quote and USDT-rate bootstrap failures are localized, finite, and retryable", () => {
  assert.match(proxyQuote, /const \[quoteAttempt, setQuoteAttempt\] = useState\(0\)/);
  for (const status of [401, 403, 409]) assert.match(proxyQuote, new RegExp(`status === ${status}`));
  assert.match(proxyQuote, /\[500, 503\]\.includes\((?:response\.)?status\)/);
  assert.match(proxyQuote, /error\?\.name === "TimeoutError" \|\| error\?\.code === "request_timeout"/);
  assert.match(proxyQuote, /error\?\.code === "invalid_json"/);
  assert.match(proxyQuote, /setQuoteAttempt\(\(current\) => current \+ 1\)/);
  assert.match(proxyQuote, /const \[rateState, setRateState\] = useState\(\{ loading: true, error: "" \}\)/);
  assert.match(proxyQuote, /setRateState\(\{ loading: false, error: message \}\)/);
  assert.match(proxyQuote, /rateState\.error[\s\S]*role="alert"[\s\S]*onClick=\{loadUsdtRate\}/);
  assert.match(proxyQuote, /const rateReady = !isUsdt \|\| \(!rateState\.loading && !rateState\.error && usdtAmount > 0\)/);
  assert.match(proxyQuote, /\{paymentUiReady && <div className=\{`proxy-payment-qr-frame/);
  assert.match(proxyQuote, /isUsdt && paymentUiReady && \(/);
  assert.match(proxyQuote, /error\.invalidatesQuote = \[[\s\S]*?quote_expired[\s\S]*?payment_method_conflict/);
  assert.match(proxyQuote, /if \(error\?\.invalidatesQuote\) \{[\s\S]*?setOrder\(null\)/);
  assert.match(proxyQuote, /const \[paymentUncertain, setPaymentUncertain\] = useState\(false\)/);
  assert.match(proxyQuote, /paymentUiReady = settingsState\.ready && rateReady && !paymentUncertain/);
  assert.match(proxyQuote, /付款提交结果尚未确认[\s\S]*?收款码和付款方式已锁定/);
  assert.match(proxyQuote, /onClick=\{paymentUncertain \? \(\) => setQuoteAttempt/);
});

test("all remaining audited account, notification, quote, and mail workflows have explicit finite exits", () => {
  assert.match(account, /catch \(error\) \{[\s\S]*?setLoadError\(message\)[\s\S]*?finally \{[\s\S]*?loading: false/);
  assert.match(admin, /async function loadRegisteredMailEmails\(\)/);
  assert.match(admin, /async function loadOrderMailEmails\(\)/);
  assert.doesNotMatch(admin, /async function fetch(?:Registered|Order)MailEmails\(\)/);

  assert.match(emailSettings, /finally \{\s*if \(requestId === loadRequestRef\.current\) \{\s*setState\(\(current\) => \(\{ \.\.\.current, loading: false, saving: false \}\)\)/);
  assert.match(emailSettings, /finally \{\s*setState\(\(current\) => \(\{ \.\.\.current, saving: false \}\)\)/);
  assert.match(proxyQuote, /finally \{\s*if \(requestId === rateRequestRef\.current\) \{\s*setRateState\(\(current\) => \(\{ \.\.\.current, loading: false \}\)\)/);
  assert.match(pushSettings, /fetchPushAccountState as loadPushAccountState/);
  assert.match(pushSettings, /loadPushAccountState\(\)/);

  for (const source of [preferenceForm, unsubscribeConfirmation]) {
    assert.match(source, /import \{ clientFetch as fetch, isClientRequestTimeout \} from "\.\.\/\.\.\/lib\/client-fetch"/);
    assert.match(source, /isClientRequestTimeout\(error\)/);
    assert.match(source, /error\?\.name === "TypeError"/);
  }
  assert.match(preferenceForm, /saving: false/);
  assert.match(unsubscribeConfirmation, /submitting: false/);
});

test("account, checkout, service center and redeem auth failures never masquerade as signed-out", () => {
  assert.match(account, /import \{ clientFetch as fetch, isClientRequestTimeout \} from "\.\.\/lib\/client-fetch"/);
  assert.match(account, /fetchImpl: fetch/);
  assert.match(account, /financeReady: false,[\s\S]*financeError: result\.error/);

  assert.match(checkout, /if \(meRes\.status === 401\)[\s\S]*setAuthedUser\(null\)[\s\S]*setAccountReady\(true\)/);
  assert.match(checkout, /const \[accountError, setAccountError\] = useState\(""\)/);
  assert.match(checkout, /const accountLoadRequestRef = useRef\(0\)/);
  const accountRefresh = checkout.slice(checkout.indexOf("async function refreshAccountState"), checkout.indexOf("// Pre-fill email"));
  assert.ok(accountRefresh.indexOf("requestId !== accountLoadRequestRef.current") < accountRefresh.indexOf("if (meRes.status === 401)"), "a stale 401 must not overwrite a newer signed-in response");
  assert.match(accountRefresh, /catch \(e\) \{\s*if \(isCancelled\(\) \|\| requestId !== accountLoadRequestRef\.current\) return/);
  assert.match(checkout, /disabled=\{cartCount === 0 \|\| submitting \|\| !accountReady \|\| !checkoutPaymentReady\}/);
  assert.match(checkout, /accountError[\s\S]*onClick=\{\(\) => refreshAccountState\(\)\}/);
  assert.match(checkout, /const \[authSessionPending, setAuthSessionPending\] = useState\(false\)/);
  assert.match(checkout, /if \(authSessionPending\) \{[\s\S]*?await refreshAccountState\([^)]*[\s\S]*?return;/);
  assert.match(checkout, /setAuthSessionPending\(true\);[\s\S]*?const account = await refreshAccountState\(/);
  assert.match(checkout, /只重试确认登录状态/);
  assert.match(checkout, /e\.key === "Escape" && !authBusy && !authSessionPending/);
  assert.doesNotMatch(checkout, /if \(!authModal\) setAuthSessionPending\(false\)/);
  assert.match(checkout, /href=\{authBusy \|\| authSessionPending \? undefined : GOOGLE_OAUTH_START\}/);
  assert.match(checkout, /aria-disabled=\{authBusy \|\| authSessionPending\}/);
  assert.match(checkout, /recovery: safeLoginAfterConfirmedAuth\(attemptedMode, attemptedForm\)/);
  assert.match(checkout, /shouldReauthenticateAfterAuthVerification\(account\)[\s\S]{0,180}?enterSafeCheckoutLogin/);
  assert.match(checkout, /setAuthSessionPending\(false\);[\s\S]{0,180}?setAuthModal\(recovery\.mode\)/);

  for (const source of [serviceCenter, redeemCard]) {
    assert.match(source, /if \(response\.status === 401\) \{\s*setAuthUser\(false\)/);
    assert.match(source, /const \[authLoadError, setAuthLoadError\] = useState\(""\)/);
    assert.match(source, /authLoadError[\s\S]*onClick=\{loadAuthState\}/);
    assert.match(source, /if \(authUser === null\)/);
    assert.match(source, /authLoadRequestRef\.current \+= 1;\s*setAuthUser\(\{ email: data\.email/);
    assert.doesNotMatch(source, /catch\(\(\) => setAuthUser\(false\)\)/);
  }
});

test("confirmed auth sessions cannot expose another account or replay register/reset after verification fails", () => {
  assert.match(account, /const pinnedIdentity = expectedIdentity[\s\S]*?typeof expectedIdentity\.email === "string"[\s\S]*?expectedIdentity: pinnedIdentity/);
  assert.match(account, /await load\(\{\s*email: attemptedForm\.email,\s*accountLifecycleId: data\.accountLifecycleId/);
  assert.match(account, /if \(!accountResult\?\.ok\) \{[\s\S]*?safeLoginAfterConfirmedAuth\(attemptedMode, attemptedForm\)[\s\S]*?setAuthMode\(recovery\.mode\)/);
  assert.ok(
    account.indexOf("const accountResult = await load") < account.indexOf("window.location.replace(returnTo)"),
    "post-auth identity must be verified before redirecting",
  );
  assert.match(checkout, /expectedIdentity && !authenticatedUserMatches\([\s\S]*?expectedIdentity\.accountLifecycleId/);

  for (const [source, hasAutoRedeem] of [[serviceCenter, false], [redeemCard, true]]) {
    const start = source.indexOf("if (res.status === 401)");
    assert.ok(start >= 0, "missing expired-session recovery");
    const end = source.indexOf("if (isExplicitTerminalIdempotencyResponse", start);
    const branch = source.slice(start, end);
    assert.match(branch, /setAuthUser\(false\)/);
    assert.match(branch, /setAuthModal\("login"\)/);
    assert.match(branch, /手动再次点击兑换，不会自动重复提交/);
    assert.doesNotMatch(branch, /clearSinglePendingOperation/);
    if (hasAutoRedeem) assert.match(branch, /setPendingRedeem\(false\)/);
  }
});

test("all four password-recovery forms require an HTTP and JSON success before claiming mail was sent", () => {
  for (const [source, functionName] of [[account, "doAuth"], [checkout, "doCheckoutAuth"], [serviceCenter, "doAuth"], [redeemCard, "doAuth"]]) {
    const start = source.indexOf(`async function ${functionName}`);
    assert.ok(start >= 0, `missing ${functionName}`);
    const body = source.slice(start, start + 8_000);
    const guard = body.indexOf("if (!isSuccessfulAuthResponse(res, data, attemptedMode))");
    const success = body.indexOf('if (attemptedMode === "forgot")', guard);
    assert.ok(guard >= 0, "missing response success guard");
    assert.ok(success > guard, "forgot success must follow the response guard");
    assert.match(body.slice(success, success + 600), /如果该邮箱已注册，验证码会发送至邮箱/);
    assert.match(body.slice(guard, guard + 300), /isSuccessfulAuthResponse\(res, data, attemptedMode\)/);
  }
});

test("all account surfaces recover uncertain register/reset results through session probe or safe login", () => {
  for (const source of [account, checkout, serviceCenter, redeemCard]) {
    assert.match(source, /safeLoginAfterUncertainAuth/);
    assert.match(source, /const attemptedMode = auth(?:Mode|Modal)/);
    assert.match(source, /const attemptedForm = \{ \.\.\.authForm, email: authForm\.email\.trim\(\)\.toLowerCase\(\) \}/);
    assert.match(source, /let responseConfirmed = false/);
    assert.match(source, /shouldRecoverAuthMutationResponse\(attemptedMode, res\.status, data\?\.error\)/);
    assert.match(source, /!responseConfirmed \? safeLoginAfterUncertainAuth\(attemptedMode, attemptedForm\) : null/);
    assert.match(source, /authenticatedUserMatches/);
    assert.doesNotMatch(source, /probeAuthenticatedUser\(fetch, attemptedForm\.email\)/);
    assert.match(source, /已切换为安全登录验证，不会重复提交原操作/);
  }
});

test("auth requests pin their mode and target identity while every mode switch is disabled", () => {
  for (const [source, functionName] of [[account, "doAuth"], [checkout, "doCheckoutAuth"], [serviceCenter, "doAuth"], [redeemCard, "doAuth"]]) {
    const start = source.indexOf(`async function ${functionName}`);
    const body = source.slice(start, start + 9_000);
    assert.match(body, /fetch\(`\/api\/auth\/\$\{(?:attemptedMode|endpoint)\}`/);
    assert.match(body, /if \(attemptedMode === "forgot"\)/);
    assert.doesNotMatch(body, /if \(auth(?:Mode|Modal) === "forgot"\)/);
    assert.match(body, /email: attemptedForm\.email, code: "", newPassword: ""/);
    assert.match(body, /authenticatedUserMatches\(data, attemptedForm\.email, data\?\.accountLifecycleId\)[\s\S]{0,180}?responseConfirmed = true/);
    assert.match(source, /className=\{`auth-tab[\s\S]{0,240}?disabled=\{authBusy\}/);
    assert.match(source, /className="auth-switch"[\s\S]{0,180}?disabled=\{authBusy\}/);
    assert.match(source, /type="email"[\s\S]{0,520}?disabled=\{authBusy(?: \|\| authSessionPending)?\}/);
    assert.match(source, /href=\{authBusy(?: \|\| authSessionPending)? \? undefined : [^}]+\}[\s\S]{0,180}?tabIndex=\{authBusy(?: \|\| authSessionPending)? \? -1 : undefined\}/);
  }

  assert.match(account, /type="email"[\s\S]{0,500}?readOnly=\{authMode === "reset"\}[\s\S]{0,100}?disabled=\{authBusy\}/);
  for (const source of [serviceCenter, redeemCard]) {
    assert.match(source, /type="email"[\s\S]{0,500}?readOnly=\{authModal === "reset"\}[\s\S]{0,100}?disabled=\{authBusy\}/);
  }
});

test("every admin JSX file that performs fetch uses a deadline-aware request", async () => {
  const directory = new URL("../app/admin/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".jsx"));
  const unchecked = [];
  for (const name of names) {
    const source = await readFile(new URL(name, directory), "utf8");
    if (!/\bfetch\(/.test(source)) continue;
    if (/\b(?:globalThis|window)\.fetch\s*\(/.test(source)) { unchecked.push(name); continue; }
    const importsDeadlineFetch = /import \{[^}]*clientFetch as fetch[^}]*\} from "\.\.\/lib\/client-fetch"/.test(source);
    const ownsBoundedRequestJson = /async function requestJson\([^)]*timeoutMs[\s\S]*?new AbortController\(\)[\s\S]*?controller\.abort\(\)[\s\S]*?await response\.json\(\)/.test(source)
      && (source.match(/\bfetch\(/g) || []).length === 1;
    if (!importsDeadlineFetch && !ownsBoundedRequestJson) unchecked.push(name);
  }
  assert.deepEqual(unchecked, []);
});
