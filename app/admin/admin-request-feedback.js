import { withClientDeadline } from "../lib/client-fetch.js";

const ADMIN_RESPONSE_BODY_TIMEOUT_MS = 15_000;
let adminRequestEpoch = 0;

function isObservedAdminRequest(input, target) {
  const raw = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
  if (!raw) return false;
  try {
    const base = target?.location?.href || "https://www.liumeiti.vip/admin";
    const url = new URL(raw, base);
    if (target?.location?.origin && url.origin !== target.location.origin) return false;
    return /^\/api\/admin(?:\/|$)/.test(url.pathname) && url.pathname !== "/api/admin/login";
  } catch {
    return false;
  }
}

export function rotateAdminRequestEpoch() {
  adminRequestEpoch += 1;
  return adminRequestEpoch;
}

/**
 * Observe protected admin requests without changing their response contract.
 * Each request captures the current client-session epoch, so a late 401 from
 * the previous administrator cannot sign out a newly authenticated account.
 */
export function installAdminUnauthorizedObserver(onUnauthorized, target = globalThis.window) {
  if (!target || typeof target.fetch !== "function" || typeof onUnauthorized !== "function") return () => {};
  const originalFetch = target.fetch;
  const observedFetch = async (...args) => {
    const requestEpoch = adminRequestEpoch;
    const response = await originalFetch.apply(target, args);
    if (
      response?.status === 401
      && requestEpoch === adminRequestEpoch
      && isObservedAdminRequest(args[0], target)
    ) {
      try { onUnauthorized(response); } catch {}
    }
    return response;
  };
  target.fetch = observedFetch;
  return () => {
    rotateAdminRequestEpoch();
    if (target.fetch === observedFetch) target.fetch = originalFetch;
  };
}

export async function readAdminJson(response, { timeoutMs = ADMIN_RESPONSE_BODY_TIMEOUT_MS } = {}) {
  let payload;
  try {
    payload = await withClientDeadline(response.json(), timeoutMs, "response_body_timeout");
  } catch (cause) {
    if (cause?.name === "TimeoutError") {
      cause.responseStatus = Number(response?.status || 0);
      throw cause;
    }
    const error = new Error("invalid_json", { cause });
    error.code = "invalid_json";
    error.responseStatus = Number(response?.status || 0);
    throw error;
  }

  if (!response?.ok || payload?.ok !== true) {
    const error = new Error(String(payload?.error || `http_${Number(response?.status || 0)}`));
    error.code = String(payload?.error || "request_failed");
    error.responseStatus = Number(response?.status || 0);
    throw error;
  }
  return payload;
}

export function adminRequestErrorMessage(error, action = "后台数据加载") {
  const status = Number(error?.responseStatus || 0);
  if (error?.name === "TimeoutError" || ["request_timeout", "response_body_timeout"].includes(error?.code)) {
    return `${action}超时，页面已停止等待，请重试。`;
  }
  if (status === 401) return "后台登录已失效，请重新登录后重试。";
  if (status === 403) return `当前后台账号没有执行“${action}”的权限。`;
  if (status === 409) return `${action}时数据已被其他管理员更新，请刷新后重试。`;
  if (status === 500) return `${action}失败，服务器处理异常，请稍后重试。`;
  if (status === 503) return `${action}失败，后台服务暂时不可用，请稍后重试。`;
  if (error?.code === "invalid_json" || error instanceof SyntaxError) {
    return `${action}失败，后台返回了无法解析的数据，请重试。`;
  }
  if (error?.name === "AbortError") return `${action}已取消，请重试。`;
  return `${action}失败，无法连接后台，请检查网络后重试。`;
}

export function adminLoginErrorMessage(status, payload, cause = null) {
  const code = String(payload?.error || cause?.code || "login_failed");
  if (["invalid_credentials", "invalid_password"].includes(code)) {
    return "账号或密码错误，请检查后重试。";
  }
  if (code === "invalid_2fa") return "动态码错误，请重试（也可输入备用恢复码）。";
  const error = {
    name: cause?.name || "Error",
    code: cause instanceof SyntaxError ? "invalid_json" : code,
    responseStatus: Number(status || cause?.responseStatus || 0),
  };
  return adminRequestErrorMessage(error, "后台登录");
}
