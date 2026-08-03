const SERVICE_WORKER_URL = "/sw.js";
let pushAccountStatePromise = null;

export function invalidatePushAccountStateCache() {
  pushAccountStatePromise = null;
}

export function browserPushCapability() {
  if (typeof window === "undefined") return { supported: false, permission: "unsupported", iosNeedsInstall: false };
  const supported = window.isSecureContext
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
  const ua = navigator.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
  return {
    supported,
    permission: supported ? Notification.permission : "unsupported",
    iosNeedsInstall: Boolean(ios && !standalone),
  };
}

function base64UrlBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function pushSubscriptionMatchesVapidKey(subscription, publicKey) {
  const actualValue = subscription?.options?.applicationServerKey;
  if (!actualValue) return true;
  try {
    const expected = base64UrlBytes(publicKey);
    const actual = new Uint8Array(actualValue);
    if (actual.length !== expected.length) return false;
    return actual.every((byte, index) => byte === expected[index]);
  } catch { return false; }
}

export async function browserPushSubscriptionId(endpoint) {
  if (!endpoint || !globalThis.crypto?.subtle) return "";
  const bytes = new TextEncoder().encode(String(endpoint));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function registerPushServiceWorker() {
  const capability = browserPushCapability();
  if (!capability.supported) throw new Error("push_unsupported");
  await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
    scope: "/",
    updateViaCache: "none",
  });
  return navigator.serviceWorker.ready;
}

export async function currentBrowserPushSubscription() {
  const capability = browserPushCapability();
  if (!capability.supported) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function fetchPushAccountState() {
  const response = await fetch("/api/auth/push/subscriptions", {
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "push_state_failed");
  return data;
}

export function fetchPushAccountStateCached({ refresh = false } = {}) {
  if (refresh || !pushAccountStatePromise) {
    pushAccountStatePromise = fetchPushAccountState().catch((error) => {
      pushAccountStatePromise = null;
      throw error;
    });
  }
  return pushAccountStatePromise;
}

export function hasRemotePushSubscription(accountState, currentSubscriptionId = "") {
  const subscriptionIds = Array.isArray(accountState?.subscriptionIds) ? accountState.subscriptionIds : [];
  const validIds = Array.isArray(accountState?.validSubscriptionIds)
    ? accountState.validSubscriptionIds
    : subscriptionIds;
  const currentId = String(currentSubscriptionId || "").trim();
  return validIds.some((id) => {
    const candidate = String(id || "").trim();
    return Boolean(candidate && candidate !== currentId);
  });
}

export async function reconcileBrowserPushSubscription({ accountState, subscription, locale = "zh" } = {}) {
  const id = await browserPushSubscriptionId(subscription?.endpoint);
  const subscriptionIds = Array.isArray(accountState?.subscriptionIds) ? accountState.subscriptionIds : [];
  const validIds = Array.isArray(accountState?.validSubscriptionIds)
    ? accountState.validSubscriptionIds
    : subscriptionIds;
  if (
    !accountState?.enabled
    || !accountState?.configured
    || !id
    || !subscriptionIds.includes(id)
    || validIds.includes(id)
  ) return { ok: true, reconciled: false, subscriptionId: id };
  const serialized = typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription;
  const response = await fetch("/api/auth/push/subscriptions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscription: serialized,
      locale,
      preferences: accountState.preferences,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "push_reconcile_failed");
  invalidatePushAccountStateCache();
  return { ...data, reconciled: true };
}

export async function enableBrowserPush({ locale = "zh", preferences } = {}) {
  const capability = browserPushCapability();
  if (!capability.supported) throw new Error("push_unsupported");
  if (capability.iosNeedsInstall) throw new Error("push_install_required");
  // Permission must be requested while the original click/user activation is
  // still live. Network and service-worker awaits happen only afterwards.
  let permission = Notification.permission;
  if (permission === "default") {
    let timeoutId;
    const promptTimeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error("push_permission_prompt_missing")), 15_000);
    });
    try {
      permission = await Promise.race([Notification.requestPermission(), promptTimeout]);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }
  if (permission !== "granted") throw new Error(permission === "denied" ? "push_permission_denied" : "push_permission_required");
  const configResponse = await fetch("/api/auth/push/config", { cache: "no-store" });
  const config = await configResponse.json().catch(() => ({}));
  if (!configResponse.ok || !config.ok || !config.enabled || !config.configured || !config.publicKey) {
    throw new Error(config.error || "push_not_configured");
  }
  const registration = await registerPushServiceWorker();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !pushSubscriptionMatchesVapidKey(subscription, config.publicKey)) {
    const unsubscribed = await subscription.unsubscribe().catch(() => false);
    if (!unsubscribed) throw new Error("push_vapid_rotation_failed");
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlBytes(config.publicKey),
    });
  }
  const response = await fetch("/api/auth/push/subscriptions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON(), locale, preferences }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "push_subscription_failed");
  invalidatePushAccountStateCache();
  return { ...data, subscription };
}

export async function disableBrowserPush({ allDevices = false } = {}) {
  const subscription = await currentBrowserPushSubscription();
  const response = await fetch("/api/auth/push/subscriptions", {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription?.endpoint || "", allDevices }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "push_unsubscribe_failed");
  if (subscription) await subscription.unsubscribe().catch(() => false);
  invalidatePushAccountStateCache();
  return data;
}

export async function savePushPreferences(preferences) {
  const response = await fetch("/api/auth/push/subscriptions", {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferences }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "push_preferences_failed");
  invalidatePushAccountStateCache();
  return data.preferences;
}

export async function setStockPushWatch(service, plan, watching = true) {
  const response = await fetch("/api/auth/push/stock-watches", {
    method: watching ? "POST" : "DELETE",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service, plan }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "stock_watch_failed");
  invalidatePushAccountStateCache();
  return data;
}
