import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const checkout = await readFile(new URL("../app/checkout/page.jsx", import.meta.url), "utf8");
const serviceCenter = await readFile(new URL("../app/service-center/page.jsx", import.meta.url), "utf8");
const netflix = await readFile(new URL("../app/netflix-code/page.jsx", import.meta.url), "utf8");
const admin = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
const security = await readFile(new URL("../app/admin/SecurityPanel.jsx", import.meta.url), "utf8");
const pushClient = await readFile(new URL("../app/lib/push-client.js", import.meta.url), "utf8");
const proxyQuote = await readFile(new URL("../app/components/ProxyQuotePayment.jsx", import.meta.url), "utf8");
const clientFetchSource = await readFile(new URL("../app/lib/client-fetch.js", import.meta.url), "utf8");

test("shared client fetch enforces a finite deadline and keeps caller cancellation", () => {
  assert.match(clientFetchSource, /export const CLIENT_FETCH_TIMEOUT_MS = 20_000/);
  assert.match(clientFetchSource, /upstreamSignal\?\.addEventListener\?\.\("abort", relayAbort/);
  assert.match(clientFetchSource, /timedOut = true;\s*controller\.abort\(\)/);
  assert.match(clientFetchSource, /timeoutError\.name = "TimeoutError"/);
  assert.match(clientFetchSource, /clearTimeout\(timer\)/);
  assert.match(clientFetchSource, /export async function withClientDeadline/);
});

test("checkout and service center requests cannot hold their busy states forever", () => {
  assert.match(checkout, /import \{ clientFetch as fetch \} from "\.\.\/lib\/client-fetch"/);
  assert.match(serviceCenter, /import \{ clientFetch as fetch \} from "\.\.\/lib\/client-fetch"/);
  assert.match(checkout, /refreshAccountState\(\(\) => cancelled\)\.finally\(\(\) => \{\s*if \(!cancelled\) setAccountReady\(true\)/);
  assert.match(checkout, /finally \{\s*setSubmitting\(false\);/);
  assert.match(serviceCenter, /finally \{\s*setQueryLoading\(false\);/);
  assert.match(serviceCenter, /finally \{\s*setAfterSalesBusy\(false\);/);
});

test("Netflix account and order lookup always leave their loading states", () => {
  assert.match(netflix, /const REQUEST_TIMEOUT_MS = 15 \* 1000/);
  assert.match(netflix, /fetchWithTimeout\("\/api\/auth\/me"/);
  assert.match(netflix, /\.finally\(\(\) => \{ if \(alive\) setLoadingAccount\(false\); \}\)/);
  assert.match(netflix, /finally \{\s*setQueryBusy\(false\);/);
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

test("every admin JSX file that performs fetch uses a deadline-aware request", async () => {
  const directory = new URL("../app/admin/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".jsx"));
  const unchecked = [];
  for (const name of names) {
    const source = await readFile(new URL(name, directory), "utf8");
    if (!/\bfetch\(/.test(source)) continue;
    if (!/client-fetch|function requestJson\([^)]*timeoutMs/.test(source)) unchecked.push(name);
  }
  assert.deepEqual(unchecked, []);
});
