"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCircle2,
  Clock3,
  Headphones,
  LoaderCircle,
  Package,
  ShoppingBag,
} from "lucide-react";
import {
  browserPushCapability,
  browserPushSubscriptionId,
  currentBrowserPushSubscription,
  disableBrowserPush,
  enableBrowserPush,
  fetchPushAccountState as loadPushAccountState,
  hasRemotePushSubscription,
  pushSubscriptionMatchesVapidKey,
  reconcileBrowserPushSubscription,
  savePushPreferences,
} from "../lib/push-client";

const CARD = {
  border: "1px solid #dbe4ef",
  borderRadius: 16,
  background: "#fff",
  padding: "17px 18px",
  display: "grid",
  gap: 14,
};

const ROW = {
  minHeight: 48,
  display: "flex",
  alignItems: "center",
  gap: 11,
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#f8fafc",
};

const BUTTON = {
  minHeight: 38,
  border: 0,
  borderRadius: 10,
  padding: "0 14px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  background: "#0f766e",
  color: "#fff",
  fontSize: 12,
  fontWeight: 850,
  cursor: "pointer",
};

function Switch({ checked, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 42,
        height: 24,
        flex: "none",
        padding: 2,
        border: 0,
        borderRadius: 999,
        background: checked ? "#0f766e" : "#cbd5e1",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span style={{
        width: 20,
        height: 20,
        display: "block",
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 4px rgba(15,23,42,.24)",
        transform: checked ? "translateX(18px)" : "translateX(0)",
        transition: "transform .18s ease",
      }} />
    </button>
  );
}

export default function PushNotificationSettings({ locale = "zh" }) {
  const en = locale === "en";
  const L = (zh, english) => en ? english : zh;
  const [state, setState] = useState(null);
  const [capability, setCapability] = useState({ supported: false, permission: "unsupported", iosNeedsInstall: false });
  const [currentEnabled, setCurrentEnabled] = useState(false);
  const [currentSubscriptionId, setCurrentSubscriptionId] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const detected = browserPushCapability();
    setCapability(detected);
    setLoading(true);
    setLoadError("");
    setMessage(null);
    try {
      const [loadedAccountState, subscription] = await Promise.all([
        loadPushAccountState(),
        currentBrowserPushSubscription(),
      ]);
      let accountState = loadedAccountState;
      let enabled = false;
      let currentId = "";
      if (subscription?.endpoint) {
        const id = await browserPushSubscriptionId(subscription.endpoint);
        currentId = id;
        const matchesVapidKey = pushSubscriptionMatchesVapidKey(subscription, accountState.publicKey);
        const belongsToAccount = Boolean(id && accountState.subscriptionIds?.includes(id));
        const validIds = Array.isArray(accountState.validSubscriptionIds)
          ? accountState.validSubscriptionIds
          : accountState.subscriptionIds;
        if (matchesVapidKey && belongsToAccount && !validIds?.includes(id) && detected.permission === "granted") {
          try {
            const rebound = await reconcileBrowserPushSubscription({ accountState, subscription, locale });
            if (rebound.reconciled) {
              accountState = {
                ...accountState,
                preferences: rebound.preferences || accountState.preferences,
                validSubscriptionIds: [...new Set([...(accountState.validSubscriptionIds || []), rebound.subscriptionId])],
              };
            }
          } catch {
            // Keep the device visibly off if the silent auth-version refresh
            // cannot be persisted. The next settings load will retry safely.
          }
        }
        const currentValidIds = Array.isArray(accountState.validSubscriptionIds)
          ? accountState.validSubscriptionIds
          : accountState.subscriptionIds;
        enabled = Boolean(matchesVapidKey && id && currentValidIds?.includes(id));
      }
      if (requestId !== loadRequestRef.current) return false;
      setState(accountState);
      setCurrentEnabled(enabled);
      setCurrentSubscriptionId(currentId);
      return true;
    } catch (error) {
      if (requestId !== loadRequestRef.current) return false;
      setLoadError(error?.name === "TimeoutError" || error?.code === "request_timeout"
        ? L("通知设置加载超时，请重试", "Notification settings timed out. Please retry.")
        : L("通知设置暂时无法加载，请检查网络后重试", "Notification settings couldn't load. Check your connection and retry."));
      return false;
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [en]);

  useEffect(() => {
    load();
    return () => { loadRequestRef.current += 1; };
  }, [load]);

  async function enable() {
    if (busy) return;
    setBusy("enable");
    setMessage(null);
    try {
      const result = await enableBrowserPush({ locale, preferences: state?.preferences });
      setCurrentEnabled(true);
      setCurrentSubscriptionId(result.subscriptionId || "");
      setCapability(browserPushCapability());
      setState((current) => current ? {
        ...current,
        preferences: result.preferences || current.preferences,
        subscriptionIds: [...new Set([...(current.subscriptionIds || []), result.subscriptionId])],
        validSubscriptionIds: [...new Set([...(current.validSubscriptionIds || []), result.subscriptionId])],
      } : current);
      setMessage({ type: "ok", text: L("此设备已开启浏览器通知", "Browser notifications are on for this device") });
    } catch (error) {
      const text = {
        push_install_required: L("iPhone / iPad 请先将网站添加到主屏幕，再从主屏幕图标打开并开启通知。", "On iPhone or iPad, add this site to the Home Screen, open it there, then enable notifications."),
        push_permission_denied: L("浏览器已拒绝通知，请在浏览器或系统设置中恢复权限。", "Notifications are blocked. Restore permission in your browser or system settings."),
        push_permission_required: L("尚未允许通知。请在权限提示中选择“允许”；若提示已关闭，请从地址栏左侧的网站图标进入“此网站的权限”，把“通知”设为“允许”。", "Notification permission wasn't granted. Choose Allow in the prompt, or open the site controls beside the address bar and set Notifications to Allow."),
        push_permission_prompt_missing: L("15 秒内未收到浏览器权限结果。如果没有看到提示，请点击地址栏左侧的网站图标，进入“此网站的权限”，把“通知”设为“允许”后重试。", "No permission result arrived within 15 seconds. If no prompt appeared, open the site controls beside the address bar, set Notifications to Allow, then retry."),
        push_not_configured: L("浏览器通知服务暂未配置完成", "Browser notifications aren't configured yet"),
        push_unsupported: L("当前浏览器不支持网站通知", "This browser doesn't support web notifications"),
      }[error?.message] || L("开启失败，请稍后再试", "Couldn't enable notifications. Try again later.");
      setMessage({ type: "error", text });
      setCapability(browserPushCapability());
    } finally { setBusy(""); }
  }

  async function disable(allDevices = false) {
    if (busy) return;
    setBusy(allDevices ? "all" : "disable");
    setMessage(null);
    try {
      await disableBrowserPush({ allDevices });
      setCurrentEnabled(false);
      if (allDevices) {
        setCurrentSubscriptionId("");
        setState((current) => current ? { ...current, subscriptionIds: [], validSubscriptionIds: [] } : current);
      }
      else if (!await load()) return;
      setMessage({
        type: "ok",
        text: allDevices
          ? L("全部设备的浏览器通知已关闭", "Browser notifications are off on all devices")
          : L("此设备的浏览器通知已关闭", "Browser notifications are off on this device"),
      });
    } catch {
      setMessage({ type: "error", text: L("关闭失败，为避免遗漏请稍后重试", "Couldn't turn notifications off. Please retry.") });
    } finally { setBusy(""); }
  }

  async function changePreference(key, value) {
    if (!state?.preferences || busy) return;
    const previous = state.preferences;
    const next = { ...previous, [key]: value, locale };
    setState((current) => ({ ...current, preferences: next }));
    setBusy(`preference:${key}`);
    setMessage(null);
    try {
      const saved = await savePushPreferences(next);
      setState((current) => ({ ...current, preferences: saved }));
    } catch {
      setState((current) => ({ ...current, preferences: previous }));
      setMessage({ type: "error", text: L("通知偏好保存失败", "Couldn't save notification preferences") });
    } finally { setBusy(""); }
  }

  const rows = [
    { key: "orders", Icon: ShoppingBag, title: L("订单进度", "Order updates"), desc: L("报价、付款确认、完成和异常状态", "Quotes, payment confirmation, completion and status issues") },
    { key: "afterSales", Icon: Headphones, title: L("售后处理", "After-sales updates"), desc: L("工单处理完成和后续进展", "Ticket completion and future updates") },
    { key: "renewals", Icon: Clock3, title: L("续费提醒", "Renewal reminders"), desc: L("服务临近到期时提醒", "Reminders when a service is close to expiry") },
    { key: "stock", Icon: Package, title: L("到货提醒", "Back-in-stock alerts"), desc: L("只提醒你主动关注的售罄规格", "Only for sold-out plans you explicitly watch") },
  ];
  const hasRemoteSubscription = hasRemotePushSubscription(state, currentSubscriptionId);

  if (loading) {
    return <section style={CARD}><span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#64748b", fontSize: 12 }}><LoaderCircle size={15} className="spin-icon" />{L("加载通知设置", "Loading notification settings")}</span></section>;
  }
  if (loadError || !state) return <section style={CARD} aria-labelledby="push-settings-error-title">
    <strong id="push-settings-error-title">{L("浏览器通知", "Browser notifications")}</strong>
    <p role="alert" style={{ color: "#b42318", margin: 0, fontSize: 12, lineHeight: 1.55 }}>{loadError || L("通知设置暂时无法加载", "Notification settings couldn't load.")}</p>
    <button type="button" style={BUTTON} onClick={load}>{L("重试", "Retry")}</button>
  </section>;

  return (
    <section style={CARD} aria-labelledby="push-settings-title">
      <header style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
        <span style={{ width: 38, height: 38, display: "grid", placeItems: "center", flex: "none", borderRadius: 11, background: "#ccfbf1", color: "#0f766e" }}>
          {currentEnabled ? <Bell size={19} /> : <BellOff size={19} />}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong id="push-settings-title" style={{ display: "block", color: "#0f172a", fontSize: 15, fontWeight: 900 }}>{L("浏览器通知", "Browser notifications")}</strong>
          <span style={{ display: "block", marginTop: 3, color: "#64748b", fontSize: 11, lineHeight: 1.55 }}>{L("即使网页没有打开，也能收到订单、售后、续费和到货进展。", "Receive order, support, renewal and stock updates even when this site isn't open.")}</span>
        </div>
        <span style={{ flex: "none", padding: "5px 8px", borderRadius: 999, background: currentEnabled ? "#ecfdf5" : "#f1f5f9", color: currentEnabled ? "#047857" : "#64748b", fontSize: 10, fontWeight: 850 }}>
          {currentEnabled ? L("此设备已开启", "On for this device") : L("此设备未开启", "Off for this device")}
        </span>
      </header>

      {!state.enabled || !state.configured ? (
        <div style={{ ...ROW, background: "#fff7ed", borderColor: "#fed7aa", color: "#9a3412", fontSize: 11.5 }}><AlertTriangle size={16} />{L("浏览器通知服务正在准备中，暂时无法开启。", "Browser notifications are being prepared and can't be enabled yet.")}</div>
      ) : !capability.supported ? (
        <div style={{ ...ROW, color: "#64748b", fontSize: 11.5 }}><AlertTriangle size={16} />{L("当前浏览器或环境不支持网站通知。", "This browser or environment doesn't support web notifications.")}</div>
      ) : capability.iosNeedsInstall ? (
        <div style={{ ...ROW, background: "#eff6ff", borderColor: "#bfdbfe", color: "#1d4ed8", fontSize: 11.5 }}><AlertTriangle size={16} />{L("iPhone / iPad 需先“添加到主屏幕”，再从主屏幕图标打开本站。", "On iPhone or iPad, first add this site to the Home Screen, then open it from the icon.")}</div>
      ) : capability.permission === "denied" ? (
        <div style={{ ...ROW, background: "#fff1f2", borderColor: "#fecdd3", color: "#be123c", fontSize: 11.5 }}><AlertTriangle size={16} />{L("通知权限已被浏览器阻止，请在网站权限或系统设置中重新允许。", "Notifications are blocked. Re-enable them in site permissions or system settings.")}</div>
      ) : null}

      <div style={{ display: "grid", gap: 8 }}>
        {rows.map(({ key, Icon, title, desc }) => (
          <div key={key} style={ROW}>
            <Icon size={17} style={{ flex: "none", color: "#0f766e" }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong style={{ display: "block", color: "#1e293b", fontSize: 12.5, fontWeight: 850 }}>{title}</strong>
              <span style={{ display: "block", marginTop: 2, color: "#64748b", fontSize: 10.5, lineHeight: 1.45 }}>{desc}</span>
            </div>
            <Switch
              checked={state.preferences?.[key] !== false}
              disabled={Boolean(busy) || !state.configured}
              onChange={(value) => changePreference(key, value)}
              label={title}
            />
          </div>
        ))}
      </div>

      {message && (
        <div role={message.type === "ok" ? "status" : "alert"} style={{ display: "flex", alignItems: "flex-start", gap: 7, padding: "9px 11px", borderRadius: 10, background: message.type === "ok" ? "#ecfdf5" : "#fff1f2", color: message.type === "ok" ? "#047857" : "#be123c", fontSize: 11, fontWeight: 750, lineHeight: 1.5 }}>
          {message.type === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{message.text}
        </div>
      )}

      <footer style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {!currentEnabled ? (
          <button type="button" style={{ ...BUTTON, opacity: busy || !state.configured || !capability.supported || capability.iosNeedsInstall || capability.permission === "denied" ? .55 : 1 }} onClick={enable} disabled={Boolean(busy) || !state.configured || !capability.supported || capability.iosNeedsInstall || capability.permission === "denied"}>
            {busy === "enable" ? <LoaderCircle size={14} className="spin-icon" /> : <Bell size={14} />}{L("在此设备开启", "Enable on this device")}
          </button>
        ) : (
          <button type="button" style={{ ...BUTTON, background: "#fff", color: "#475569", border: "1px solid #cbd5e1" }} onClick={() => disable(false)} disabled={Boolean(busy)}>
            {busy === "disable" ? <LoaderCircle size={14} className="spin-icon" /> : <BellOff size={14} />}{L("关闭此设备", "Disable this device")}
          </button>
        )}
        {hasRemoteSubscription && (
          <button type="button" style={{ ...BUTTON, background: "transparent", color: "#b91c1c", border: "1px solid #fecaca" }} onClick={() => disable(true)} disabled={Boolean(busy)}>
            {busy === "all" ? <LoaderCircle size={14} className="spin-icon" /> : <BellOff size={14} />}{L("关闭全部设备", "Disable all devices")}
          </button>
        )}
        <span style={{ marginLeft: "auto", color: "#94a3b8", fontSize: 11, lineHeight: 1.45 }}>{L("不会发送营销通知，也不会在锁屏显示敏感订单内容。", "No marketing push or sensitive order content on the lock screen.")}</span>
      </footer>
    </section>
  );
}
