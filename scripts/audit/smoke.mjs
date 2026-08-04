import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditRoot, finish, relative } from "./_shared.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

// These 16 sections mirror the release checklist. Sections that share one page
// (the account flows) carry separate source-contract checks, while grouped
// content/email sections enumerate every concrete page that must build.
export const SMOKE_SECTIONS = Object.freeze([
  { id: "home", pages: [{ route: "/", source: "app/page.jsx", build: "/page", http: "/" }] },
  { id: "shop", pages: [{ route: "/shop", source: "app/shop/page.jsx", build: "/shop/page", http: "/shop" }] },
  { id: "service-detail", pages: [{ route: "/services/[slug]", source: "app/services/[slug]/page.jsx", build: "/services/[slug]/page", http: "/services/spotify", bodyMarkers: ["service-landing-shell"] }] },
  {
    id: "checkout",
    pages: [{ route: "/checkout", source: "app/checkout/page.jsx", build: "/checkout/page", http: "/checkout" }],
    markers: ["/api/order", "/api/auth/me"],
  },
  { id: "quote-checkout", pages: [{ route: "/checkout/quote/[orderId]", source: "app/checkout/quote/[orderId]/page.jsx", build: "/checkout/quote/[orderId]/page", http: "/checkout/quote/smoke-nonexistent-order", allowNotFound: true, bodyMarkers: ["proxy-payment-page"] }] },
  { id: "account-login", pages: [{ route: "/account", source: "app/account/page.jsx", build: "/account/page", http: "/account" }], markers: ["attemptedMode === \"login\""] },
  { id: "account-register", pages: [{ route: "/account", source: "app/account/page.jsx", build: "/account/page", http: "/account" }], markers: ["attemptedMode === \"register\"", "/api/auth/captcha"] },
  { id: "account-reset", pages: [{ route: "/account", source: "app/account/page.jsx", build: "/account/page", http: "/account" }], markers: ["attemptedMode === \"forgot\"", "attemptedMode === \"reset\""] },
  { id: "account-center", pages: [{ route: "/account", source: "app/account/page.jsx", build: "/account/page", http: "/account" }], markers: ["/api/auth/me"] },
  { id: "account-money", pages: [{ route: "/account", source: "app/account/page.jsx", build: "/account/page", http: "/account" }], markers: ["/api/auth/withdraw", "/api/auth/transfer", "/api/auth/redeem"] },
  { id: "service-center", pages: [{ route: "/service-center", source: "app/service-center/page.jsx", build: "/service-center/page", http: "/service-center" }], markers: ["/api/order-query", "/api/after-sales", "/api/order-password-update/resend"] },
  { id: "netflix-code", pages: [{ route: "/netflix-code", source: "app/netflix-code/page.jsx", build: "/netflix-code/page", http: "/netflix-code" }], markers: ["/api/netflix-code"] },
  { id: "spotify-update", pages: [{ route: "/order-update/spotify/[orderId]", source: "app/order-update/spotify/[orderId]/page.jsx", build: "/order-update/spotify/[orderId]/page", http: "/order-update/spotify/smoke-nonexistent-order", allowNotFound: true, bodyMarkers: ["spotify-update-page"] }] },
  {
    id: "content",
    pages: [
      { route: "/guides", source: "app/guides/page.jsx", build: "/guides/page", http: "/guides" },
      { route: "/announcements", source: "app/announcements/page.jsx", build: "/announcements/page", http: "/announcements" },
      { route: "/legal", source: "app/legal/page.jsx", build: "/legal/page", http: "/legal" },
    ],
  },
  {
    id: "email-preferences",
    pages: [
      { route: "/email/preferences", source: "app/email/preferences/page.jsx", build: "/email/preferences/page", http: "/email/preferences?token=smoke-invalid-token" },
      { route: "/email/unsubscribe", source: "app/email/unsubscribe/page.jsx", build: "/email/unsubscribe/page", http: "/email/unsubscribe?token=smoke-invalid-token" },
    ],
  },
  { id: "admin", pages: [{ route: "/admin", source: "app/admin/page.jsx", build: "/admin/page", http: "/admin" }], markers: ["/api/admin/login", "/api/admin/orders"] },
]);

export const UNAUTHENTICATED_API_CHECKS = Object.freeze([
  { id: "user-auth", kind: "json-api", path: "/api/auth/me", expectedStatus: 401 },
  { id: "admin-netflix", kind: "json-api", path: "/api/admin/netflix-code", expectedStatus: 401 },
]);

function finding(file, code, message, line = 1) {
  return { file, line, column: 1, code, message };
}

function uniquePages(sections = SMOKE_SECTIONS) {
  const pages = new Map();
  for (const section of sections) {
    for (const page of section.pages || []) {
      const key = `${page.source}|${page.build}|${page.http}`;
      if (!pages.has(key)) pages.set(key, { ...page, sections: [] });
      pages.get(key).sections.push(section.id);
    }
  }
  return [...pages.values()];
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function sourcePath(root, expected) {
  const absolute = path.join(root, expected);
  if (await exists(absolute)) return absolute;
  const extension = path.extname(expected);
  if (!extension) return "";
  const stem = expected.slice(0, -extension.length);
  for (const candidate of [".jsx", ".js", ".tsx", ".ts"]) {
    const target = `${stem}${candidate}`;
    if (await exists(path.join(root, target))) return path.join(root, target);
  }
  return "";
}

export async function inspectSmokeArtifacts({ root, sections = SMOKE_SECTIONS } = {}) {
  const findings = [];
  const resolvedRoot = path.resolve(root || auditRoot([]));
  const sources = new Map();

  for (const page of uniquePages(sections)) {
    const file = await sourcePath(resolvedRoot, page.source);
    if (!file) {
      findings.push(finding(page.source, "smoke-source-missing", `${page.route} 缺少页面源码`));
      continue;
    }
    if (!sources.has(page.source)) sources.set(page.source, await readFile(file, "utf8"));
  }

  for (const section of sections) {
    if (!section.markers?.length) continue;
    const combinedSource = (section.pages || []).map((page) => sources.get(page.source) || "").join("\n");
    for (const marker of section.markers) {
      if (!combinedSource.includes(marker)) {
        const file = section.pages?.[0]?.source || "app";
        findings.push(finding(file, "smoke-contract-missing", `${section.id} 缺少只读可核验的功能契约 ${marker}`));
      }
    }
  }

  const manifestFile = path.join(resolvedRoot, ".next", "server", "app-paths-manifest.json");
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch (error) {
    const code = error?.code === "ENOENT" ? "smoke-build-missing" : "smoke-build-invalid";
    findings.push(finding(".next/server/app-paths-manifest.json", code, "缺少可验证的 Next.js 构建路由清单或清单不是有效 JSON"));
  }
  if (manifest !== null && (typeof manifest !== "object" || Array.isArray(manifest))) {
    findings.push(finding(".next/server/app-paths-manifest.json", "smoke-build-invalid", "Next.js 构建路由清单必须是对象"));
    manifest = null;
  }
  if (manifest) {
    for (const page of uniquePages(sections)) {
      if (!Object.hasOwn(manifest, page.build)) {
        findings.push(finding(".next/server/app-paths-manifest.json", "smoke-route-unbuilt", `${page.route} 未出现在本次构建产物中`));
      }
    }
  }

  const loadingAudit = path.join(SCRIPT_DIRECTORY, "audit-loading-states.mjs");
  const loadingResult = spawnSync(process.execPath, [loadingAudit, "--root", resolvedRoot], {
    cwd: resolvedRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (loadingResult.error) {
    findings.push(finding("scripts/audit/audit-loading-states.mjs", "smoke-loading-audit-failed", `加载态审计无法执行：${loadingResult.error.message}`));
  } else if (loadingResult.status !== 0) {
    const output = String(loadingResult.stdout || loadingResult.stderr || "未知加载态缺陷").trim();
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      findings.push(finding("scripts/audit/audit-loading-states.mjs", "smoke-loading-state", line));
    }
  }
  return findings;
}

function isUnresolvedDynamicPath(value) {
  let decoded = String(value || "");
  try { decoded = decodeURIComponent(decoded); } catch {}
  return /\[[^\]]+\]|(?:^|[?&])(?:token|slug|orderId)=<[^>]+>/i.test(decoded);
}

function absoluteUrl(baseUrl, requestPath) {
  return new URL(String(requestPath || ""), `${String(baseUrl).replace(/\/+$/, "")}/`).toString();
}

async function probeOneHttpTarget(target, { baseUrl, timeoutMs, fetchImpl }) {
  const file = `http:${target.path}`;
  if (isUnresolvedDynamicPath(target.path)) {
    return [finding(file, "smoke-dynamic-placeholder", `动态路由或令牌仍含未替换占位符：${target.path}`)];
  }
  let response;
  const requestedUrl = absoluteUrl(baseUrl, target.path);
  try {
    response = await fetchImpl(requestedUrl, {
      method: "GET",
      redirect: "manual",
      headers: { accept: target.kind === "json-api" ? "application/json" : "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return [finding(file, timedOut ? "smoke-http-timeout" : "smoke-http-network", `${target.path} ${timedOut ? "请求超时" : `网络请求失败：${error?.message || "unknown"}`}`)];
  }

  if (response.status >= 300 && response.status < 400) {
    return [finding(file, "smoke-unexpected-redirect", `${target.path} unexpectedly redirected with ${response.status}`)];
  }
  if (response.url) {
    const requested = new URL(requestedUrl);
    const final = new URL(response.url);
    if (requested.pathname !== final.pathname) {
      return [finding(file, "smoke-route-mismatch", `${target.path} resolved to ${final.pathname}`)];
    }
  }

  if (target.kind === "json-api") {
    const findings = [];
    const contentType = String(response.headers?.get?.("content-type") || "");
    if (!/\bapplication\/(?:[a-z0-9!#$&^_.+-]+\+)?json\b/i.test(contentType)) findings.push(finding(file, "smoke-api-content-type", `${target.path} did not return JSON content type`));
    if (response.status !== target.expectedStatus) {
      findings.push(finding(file, response.status >= 500 ? "smoke-http-5xx" : "smoke-api-status", `${target.path} 预期 ${target.expectedStatus}，实际 ${response.status}`));
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        findings.push(finding(file, "smoke-http-timeout", `${target.path} 响应正文超时`));
        return findings;
      }
      findings.push(finding(file, "smoke-invalid-json", `${target.path} 未返回有效 JSON`));
      return findings;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.error !== "string" || !body.error) {
      findings.push(finding(file, "smoke-api-contract", `${target.path} 的未登录响应缺少非空 error 字段`));
    }
    return findings;
  }

  if (response.status >= 500) return [finding(file, "smoke-http-5xx", `${target.path} 返回 ${response.status}`)];
  if ((response.status < 200 || response.status >= 400) && !(response.status === 404 && target.allowNotFound)) {
    return [finding(file, "smoke-page-status", `${target.path} 返回 ${response.status}`)];
  }
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  let body;
  try {
    body = await response.text();
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return [finding(file, timedOut ? "smoke-http-timeout" : "smoke-http-network", `${target.path} ${timedOut ? "响应正文超时" : `读取响应失败：${error?.message || "unknown"}`}`)];
  }
  const findings = [];
  if (!contentType.includes("text/html")) findings.push(finding(file, "smoke-page-content-type", `${target.path} 未返回 HTML`));
  if (!body.trim()) findings.push(finding(file, "smoke-page-empty", `${target.path} 返回空页面`));
  const softNotFound = /<meta[^>]+name=["']next-error["'][^>]+content=["']not-found["']|<title>\s*(?:404[^<]*|this page could not be found)|NEXT_HTTP_ERROR_FALLBACK;404/i.test(body);
  if (softNotFound) findings.push(finding(file, "smoke-soft-404", `${target.path} returned a soft 404 page`));
  for (const marker of target.bodyMarkers || []) {
    if (!body.includes(marker)) findings.push(finding(file, "smoke-page-marker-missing", `${target.path} is missing route marker ${marker}`));
  }
  return findings;
}

export async function probeSmokeHttp({
  baseUrl,
  timeoutMs = 8_000,
  targets,
  fetchImpl = globalThis.fetch,
  sections = SMOKE_SECTIONS,
} = {}) {
  if (!baseUrl) return [];
  if (typeof fetchImpl !== "function") return [finding("http", "smoke-fetch-unavailable", "当前 Node.js 运行时没有 fetch")];
  let parsed;
  try { parsed = new URL(baseUrl); } catch {
    return [finding("http", "smoke-base-url-invalid", `无效 base URL：${baseUrl}`)];
  }
  if (!/^https?:$/.test(parsed.protocol)) return [finding("http", "smoke-base-url-invalid", "base URL 只允许 http/https")];
  const requestTargets = targets || [
    ...uniquePages(sections).map((page) => ({
      id: page.route,
      kind: "page",
      path: page.http,
      allowNotFound: Boolean(page.allowNotFound),
      bodyMarkers: page.bodyMarkers || [],
    })),
    ...UNAUTHENTICATED_API_CHECKS,
  ];
  const results = await Promise.all(requestTargets.map((target) => probeOneHttpTarget(target, {
    baseUrl: parsed.toString(),
    timeoutMs: Math.max(1, Number(timeoutMs) || 8_000),
    fetchImpl,
  })));
  return results.flat();
}

export async function runSmoke({ root, baseUrl = "", timeoutMs = 8_000, sections = SMOKE_SECTIONS } = {}) {
  const resolvedRoot = path.resolve(root || auditRoot([]));
  const findings = await inspectSmokeArtifacts({ root: resolvedRoot, sections });
  findings.push(...await probeSmokeHttp({ baseUrl, timeoutMs, sections }));
  return findings.map((item) => ({ ...item, file: item.file.startsWith(resolvedRoot) ? relative(resolvedRoot, item.file) : item.file }));
}

function cliOptions(argv = process.argv.slice(2)) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? String(argv[index + 1] || "") : "";
  };
  return {
    root: auditRoot(argv),
    baseUrl: value("--base-url") || process.env.SMOKE_BASE_URL || "",
    timeoutMs: Number(value("--timeout-ms") || 8_000),
  };
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile && invokedFile.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  finish(await runSmoke(cliOptions()));
}
