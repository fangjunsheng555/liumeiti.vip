/* eslint-disable no-restricted-globals */
const PUSH_DB = "lm-push-events-v1";
const PUSH_STORE = "events";
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_PATHS = ["/account", "/shop", "/service-center", "/checkout"];

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PUSH_DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PUSH_STORE)) database.createObjectStore(PUSH_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function firstSeen(eventId) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PUSH_STORE, "readwrite");
    const store = transaction.objectStore(PUSH_STORE);
    const get = store.get(eventId);
    let duplicate = false;
    get.onsuccess = () => {
      duplicate = Boolean(get.result);
      if (!duplicate) store.put(Date.now(), eventId);
      const cutoff = Date.now() - MAX_EVENT_AGE_MS;
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        if (Number(item.value || 0) < cutoff) item.delete();
        item.continue();
      };
    };
    transaction.oncomplete = () => { database.close(); resolve(!duplicate); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}

function safePath(value) {
  const text = String(value || "");
  if (!text.startsWith("/") || text.startsWith("//") || text.length > 1000) return "/account";
  try {
    const url = new URL(text, self.location.origin);
    if (url.origin !== self.location.origin) return "/account";
    const allowed = ALLOWED_PATHS.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + "/"));
    return allowed ? url.pathname + url.search + url.hash : "/account";
  } catch { return "/account"; }
}

function normalizedPayload(event) {
  let value = {};
  try { value = event.data?.json?.() || {}; } catch { return null; }
  const eventId = String(value.eventId || "").slice(0, 100);
  const title = String(value.title || "").slice(0, 80);
  const body = String(value.body || "").slice(0, 180);
  if (Number(value.version) !== 1 || !eventId || !title || !body) return null;
  return {
    eventId,
    title,
    body,
    url: safePath(value.url),
    tag: String(value.tag || eventId).slice(0, 120),
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    category: String(value.category || "account").slice(0, 40),
  };
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  const payload = normalizedPayload(event);
  if (!payload) return;
  event.waitUntil((async () => {
    let fresh = true;
    try { fresh = await firstSeen(payload.eventId); } catch { fresh = true; }
    if (!fresh) return;
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      tag: payload.tag,
      renotify: false,
      data: { eventId: payload.eventId, url: payload.url, category: payload.category },
    });
  })());
});

function applicationServerKey(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    let subscription = event.newSubscription || null;
    if (!subscription) {
      let options = event.oldSubscription?.options || null;
      if (!options?.applicationServerKey) {
        const response = await fetch("/api/auth/push/config", { credentials: "include", cache: "no-store" });
        const config = await response.json().catch(() => ({}));
        if (!response.ok || !config.configured || !config.publicKey) return;
        options = { userVisibleOnly: true, applicationServerKey: applicationServerKey(config.publicKey) };
      }
      subscription = await self.registration.pushManager.subscribe(options);
    }
    await fetch("/api/auth/push/subscriptions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
  })().catch(() => null));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification?.data?.url);
  const targetUrl = new URL(path, self.location.origin).toString();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const sameOriginWindows = windows.filter((client) => {
      try { return new URL(client.url).origin === self.location.origin; } catch { return false; }
    });
    const existing = sameOriginWindows.find((client) => {
      try { return new URL(client.url).toString() === targetUrl; } catch { return false; }
    }) || sameOriginWindows[0];
    if (existing) {
      try {
        if (new URL(existing.url).toString() === targetUrl) return existing.focus();
        if (typeof existing.navigate === "function") {
          const navigated = await existing.navigate(targetUrl);
          if (navigated) return navigated.focus();
        }
      } catch {}
      // Older browsers can expose a WindowClient without navigate(), and a
      // navigation may also be rejected while the client is shutting down.
      // Open the intended safe URL instead of focusing an unrelated page.
      return self.clients.openWindow(targetUrl);
    }
    return self.clients.openWindow(targetUrl);
  })());
});
