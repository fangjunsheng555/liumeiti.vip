"use client";

// 站点设置 — 仅超级管理员。读写 /api/admin/settings。
// 改任何项,保存后前端站点(客服/服务中心/页脚/收款码/结账)与订单邮件即时同步。
import { useEffect, useState, useCallback, useRef } from "react";
import { LoaderCircle, Save, RotateCcw, Settings as SettingsIcon, AlertTriangle, CheckCircle2, Headphones, Coins, Layers, QrCode, Tag, FileText, Bell, Upload, DatabaseBackup, Undo2, Server, Activity } from "lucide-react";
import { clientFetch as fetch } from "../lib/client-fetch";
import { beginLatestRequest, isLatestRequest } from "../lib/latest-request";

// 图片压缩:最长边 640px,白底(利于扫码),优先 PNG,超 400KB 降级 JPEG。
async function compressImage(file) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl;
  });
  const max = 640;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  let out = canvas.toDataURL("image/png");
  if (out.length > 400000) out = canvas.toDataURL("image/jpeg", 0.88);
  if (out.length > 480000) out = canvas.toDataURL("image/jpeg", 0.7);
  return out;
}

// 收款码字段:预览 + 直接上传(压缩为 dataURL)+ 手填路径/URL
function QrField({ label, path, fallback, value, set, setMsg, error, onProcessingChange }) {
  const inputId = "qr-upload-" + path.replace(/\W/g, "-");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\//.test(file.type)) { setMsg({ type: "error", text: "请选择图片文件" }); return; }
    if (file.size > 8 * 1024 * 1024) { setMsg({ type: "error", text: "图片过大(超过 8MB)" }); return; }
    onProcessingChange?.(true);
    try {
      const out = await compressImage(file);
      if (!mountedRef.current) return;
      set(path, out);
      setMsg({ type: "ok", text: `${label}已就绪(已压缩),点右上角「保存」生效` });
    } catch (err) {
      if (mountedRef.current) setMsg({ type: "error", text: "图片处理失败,请换一张试试" });
    } finally {
      if (mountedRef.current) onProcessingChange?.(false);
    }
  }
  return (
    <div className="admin-settings-field full">
      <label>{label}</label>
      <div className="admin-settings-qr">
        <img src={value || fallback} alt={label} onError={(e) => { e.currentTarget.style.opacity = 0.3; }} />
        <div className="grow">
          <input value={value || ""} onChange={(e) => set(path, e.target.value)} placeholder={fallback} />
        </div>
        <input id={inputId} type="file" accept="image/*" style={{ display: "none" }} onChange={onFile} />
        <label htmlFor={inputId} className="admin-settings-btn" style={{ cursor: "pointer" }}><Upload size={13} />上传图片</label>
      </div>
      {error && <small className="admin-settings-field-error" role="alert">{error.message || error}</small>}
    </div>
  );
}

function Section({ icon, title, sub, onReset, disabled, children }) {
  return (
    <div className="admin-settings-section">
      <div className="admin-settings-section-title">
        <span className="ico">{icon}</span>{title}
        {onReset && <button type="button" className="admin-settings-section-reset" onClick={onReset} disabled={disabled}><Undo2 size={12} />恢复本节默认</button>}
      </div>
      {sub && <div className="admin-settings-section-sub">{sub}</div>}
      {children}
    </div>
  );
}
function Field({ label, full, children }) {
  return <label className={`admin-settings-field${full ? " full" : ""}`}><span className="admin-settings-field-label">{label}</span>{children}</label>;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function countChangedLeaves(before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return 0;
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return 1;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let count = 0;
  keys.forEach((key) => { count += countChangedLeaves(before[key], after[key]); });
  return count;
}

function normalizedSettingsDraft(value) {
  const next = clone(value);
  for (const path of ["usdt.discount", "usdt.rateOverride", "bundle.tier2Rate", "bundle.tier3Rate"]) {
    const raw = get(next, path);
    if (typeof raw !== "string" || !raw.trim()) continue;
    let target = next;
    const keys = path.split(".");
    for (let index = 0; index < keys.length - 1; index += 1) target = target[keys[index]];
    target[keys.at(-1)] = Number(raw);
  }
  return next;
}

function settingsErrorMessage(code, fallback = "设置操作失败，请重试") {
  const messages = {
    unauthorized: "仅超级管理员可管理站点设置",
    settings_store_unavailable: "设置存储暂时不可用，当前未展示可编辑默认值，请稍后重试",
    settings_store_corrupt: "设置数据格式异常，为避免覆盖线上配置，当前已停止编辑",
    settings_revision_corrupt: "设置版本记录异常，为避免覆盖他人修改，当前已停止编辑",
    invalid_base_version: "设置版本无效，请重新加载后再编辑",
  };
  return messages[code] || fallback;
}

export default function SettingsPanel({ onDirtyChange }) {
  const [s, setS] = useState(null);
  const [savedSettings, setSavedSettings] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [currentVersion, setCurrentVersion] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showPanelToken, setShowPanelToken] = useState(false);
  const [panelTest, setPanelTest] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const loadRequestRef = useRef(0);
  const uploadBusyRef = useRef(false);
  const handleUploadBusy = useCallback((busy) => {
    uploadBusyRef.current = Boolean(busy);
    setUploadBusy(Boolean(busy));
  }, []);

  const load = useCallback(async () => {
    const requestId = beginLatestRequest(loadRequestRef);
    setLoading(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/settings", { credentials: "same-origin", cache: "no-store" });
      const j = await r.json();
      if (!isLatestRequest(loadRequestRef, requestId)) return;
      if (r.ok && j.ok) {
        if (!j.settings || typeof j.settings !== "object" || Array.isArray(j.settings)) {
          throw new Error("invalid_settings_response");
        }
        setS(j.settings);
        setSavedSettings(clone(j.settings));
        setDefaults(j.defaults ? clone(j.defaults) : null);
        setCurrentVersion(Number.isSafeInteger(j.currentVersion) ? j.currentVersion : "");
        setFieldErrors({});
        setLoadFailed(false);
      }
      else {
        setLoadFailed(true);
        setMsg({ type: "error", text: settingsErrorMessage(j.error, "设置加载失败，请重试") });
      }
    } catch (e) {
      if (isLatestRequest(loadRequestRef, requestId)) {
        setLoadFailed(true);
        setMsg({ type: "error", text: e?.message === "invalid_settings_response" ? "设置返回异常，请重试" : "网络错误，请重试" });
      }
    } finally {
      if (isLatestRequest(loadRequestRef, requestId)) setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const changedCount = s && savedSettings ? countChangedLeaves(savedSettings, s) : 0;
  const dirty = changedCount > 0;
  const navigationDirty = dirty || uploadBusy;

  useEffect(() => {
    onDirtyChange?.(navigationDirty);
    return () => onDirtyChange?.(false);
  }, [navigationDirty, onDirtyChange]);

  useEffect(() => {
    if (!navigationDirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [navigationDirty]);

  function set(path, value) {
    setS((cur) => {
      const next = clone(cur);
      let o = next; const ks = path.split(".");
      for (let i = 0; i < ks.length - 1; i += 1) o = o[ks[i]];
      o[ks[ks.length - 1]] = value;
      return next;
    });
    setFieldErrors((current) => {
      if (!current[path]) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }
  function restoreSection(path) {
    if (!defaults) return;
    set(path, clone(get(defaults, path)));
    setMsg({ type: "ok", text: "已恢复本节默认值，点击“保存全部”后才会生效" });
  }
  function reload() {
    if (dirty && !window.confirm("当前有未保存的修改，确定放弃并重新加载吗？")) return;
    load();
  }
  const I = (path, props = {}) => <>
    <input value={s ? get(s, path) ?? "" : ""} onChange={(e) => set(path, e.target.value)} aria-invalid={fieldErrors[path] ? "true" : undefined} {...props} />
    {fieldErrors[path] && <small className="admin-settings-field-error" role="alert">{fieldErrors[path].message || fieldErrors[path]}</small>}
  </>;

  // Probes the saved configuration, not the draft on screen: the token only
  // reaches the server on save, so testing an unsaved edit would report on the
  // previous value and read as a false pass.
  async function testNodePanel() {
    if (panelTest?.state === "running") return;
    setPanelTest({ state: "running" });
    try {
      const r = await fetch("/api/admin/node-panel", { method: "POST", credentials: "same-origin" });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) {
        setPanelTest({ state: "done", ok: false, message: "需要超级管理员权限" });
        return;
      }
      setPanelTest({
        state: "done",
        ok: Boolean(j.ok),
        message: j.message || (j.ok ? "面板可达" : "面板不可用"),
      });
    } catch {
      setPanelTest({ state: "done", ok: false, message: "网络错误，未能完成测试" });
    }
  }

  async function save() {
    if (saving || loading || loadFailed || uploadBusyRef.current || !dirty) return;
    const submitted = normalizedSettingsDraft(s);
    // A result from before this save describes the old token, so drop it.
    setSaving(true); setMsg(null); setFieldErrors({}); setPanelTest(null);
    try {
      const r = await fetch("/api/admin/settings", {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: submitted, baseVersion: currentVersion }),
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        setS(j.settings);
        setSavedSettings(clone(j.settings));
        setCurrentVersion(Number.isSafeInteger(j.currentVersion) ? j.currentVersion : currentVersion);
        setMsg({ type: "ok", text: "已保存 · 客服、页脚、结账和订单邮件配置已同步" });
      } else if (r.status === 409 || j.error === "version_conflict") {
        setMsg({ type: "error", text: "设置已被另一个后台页面修改，请重新加载后再编辑，当前内容尚未覆盖线上配置" });
      } else {
        setFieldErrors(j.fieldErrors && typeof j.fieldErrors === "object" ? j.fieldErrors : {});
        setMsg({ type: "error", text: j.message || (j.error === "invalid_settings" ? "请检查标红字段后重试" : settingsErrorMessage(j.error, "保存失败，请重试")) });
      }
    } catch (e) { setMsg({ type: "error", text: "网络错误" }); }
    finally { setSaving(false); }
  }

  if (loading && !s) return <div style={{ display: "inline-flex", gap: 8, alignItems: "center", color: "var(--muted)", fontSize: 13 }}><LoaderCircle size={16} className="spin-icon" />加载设置…</div>;
  if (!s) return msg ? <div className="admin-settings-alert error" role="alert"><AlertTriangle size={15} />{msg.text}<button type="button" className="admin-settings-btn" onClick={load}><RotateCcw size={13} />重试</button></div> : null;

  // 组合优惠 tier 是「折扣额」(0.05=5% off=9.5折);USDT discount 是「实付倍率」(0.9=付9成=10% off=9折)
  const bundlePct = (v) => `${Math.round(Number(v || 0) * 100)}% off · ${(10 * (1 - Number(v || 0))).toFixed(1)}折`;
  const usdtPct = (v) => `${Math.round((1 - Number(v || 0)) * 100)}% off · ${(10 * Number(v || 0)).toFixed(1)}折`;

  return (
    <div className="admin-settings">
      <div className="admin-settings-head">
        <h2><SettingsIcon size={19} />站点设置</h2>
        <span className="sub">统一管理客服、付款、品牌、页脚与运营通知</span>
        {dirty && <span className="admin-settings-dirty" role="status">{changedCount} 项未保存</span>}
        <span className="spacer" />
        <button type="button" className="admin-settings-btn" onClick={reload} disabled={saving || loading || uploadBusy}><RotateCcw size={13} />重载</button>
        <button type="button" className="admin-settings-btn primary" onClick={save} disabled={saving || loading || loadFailed || uploadBusy || !dirty}>
          {saving ? <LoaderCircle size={14} className="spin-icon" /> : <Save size={14} />}{saving ? "保存中" : "保存全部"}
        </button>
      </div>
      {msg && <div className={`admin-settings-alert ${msg.type}`} role={msg.type === "error" ? "alert" : "status"}>{msg.type === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{msg.text}</div>}

      <fieldset className="admin-settings-editor" disabled={saving || loading || loadFailed || uploadBusy}>
      <Section icon={<Headphones size={15} />} title="客服联系方式" sub="浮动客服按钮、服务中心与订单邮件共用" onReset={() => restoreSection("support")} disabled={saving}>
        <div className="admin-settings-grid">
          {[["qq", "QQ"], ["whatsapp", "WhatsApp"], ["telegram", "Telegram"]].map(([k, label]) => (
            <Field key={k} label={`${label} 显示值`}>{I(`support.${k}.value`)}</Field>
          ))}
          <Field label="客服在线时间">{I("support.hours", { placeholder: "9:00 - 23:00" })}</Field>
          {[["qq", "QQ"], ["whatsapp", "WhatsApp"], ["telegram", "Telegram"]].map(([k, label]) => (
            <Field key={k} full label={`${label} 跳转链接(href)`}>{I(`support.${k}.href`)}</Field>
          ))}
        </div>
      </Section>

      <Section icon={<Coins size={15} />} title="USDT 结算" sub="影响结账实收金额、地址、二维码和自动确认，请修改后核对前台" onReset={() => restoreSection("usdt")} disabled={saving}>
        <div className="admin-settings-grid">
          <Field full label="TRC20 收款地址">{I("usdt.address")}</Field>
          <Field label={`USDT 折扣率 实付倍率(${usdtPct(s.usdt.discount)})`}>{I("usdt.discount", { type: "number", step: "0.01", min: "0.1", max: "1" })}</Field>
          <Field label="固定汇率(留空=每日自动)">{I("usdt.rateOverride", { placeholder: "自动", inputMode: "decimal" })}</Field>
        </div>
        <label className="admin-settings-check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={!!s.usdt.autoConfirm} onChange={(e) => set("usdt.autoConfirm", e.target.checked)} />
          开启 TRON 链上自动确认到账
        </label>
        <div className="admin-settings-hint">每笔 USDT 订单会生成唯一精确金额，仅确认已上链交易，不自动发货。开启前请先完成一笔真实小额测试。</div>
      </Section>

      <Section icon={<Layers size={15} />} title="组合优惠档位" sub="多件下单自动打折，三件折扣不得低于两件" onReset={() => restoreSection("bundle")} disabled={saving}>
        <div className="admin-settings-grid">
          <Field label={`满 2 件折扣(${bundlePct(s.bundle.tier2Rate)})`}>{I("bundle.tier2Rate", { type: "number", step: "0.01", min: "0", max: "0.9" })}</Field>
          <Field label={`满 3 件折扣(${bundlePct(s.bundle.tier3Rate)})`}>{I("bundle.tier3Rate", { type: "number", step: "0.01", min: "0", max: "0.9" })}</Field>
        </div>
        <div className="admin-settings-hint">填「折扣额」:0.05 = 5% off = 9.5 折;0.10 = 10% off = 9 折;0 = 无折扣。</div>
      </Section>

      <Section icon={<QrCode size={15} />} title="收款二维码" sub="支付宝与 USDT 共用前台结账展示，可上传压缩图片或填写站内路径 / HTTPS 地址" onReset={() => restoreSection("payment")} disabled={saving}>
        <div className="admin-settings-grid">
          <QrField label="支付宝收款码" path="payment.alipayQr" fallback="/payment/alipay.jpg" value={s.payment.alipayQr} set={set} setMsg={setMsg} error={fieldErrors["payment.alipayQr"]} onProcessingChange={handleUploadBusy} />
          <QrField label="USDT 收款码" path="payment.usdtQr" fallback="/payment/usdt.png" value={s.payment.usdtQr} set={set} setMsg={setMsg} error={fieldErrors["payment.usdtQr"]} onProcessingChange={handleUploadBusy} />
        </div>
      </Section>

      <Section icon={<Tag size={15} />} title="品牌 / 站点标题" sub="用于订单邮件和浏览器标签标题" onReset={() => restoreSection("brand")} disabled={saving}>
        <div className="admin-settings-grid">
          <Field label="品牌名(中文)">{I("brand.name")}</Field>
          <Field label="品牌名(英文)">{I("brand.nameEn")}</Field>
          <Field full label="站点标题(中文)">{I("brand.siteTitle")}</Field>
          <Field full label="站点标题(英文)">{I("brand.siteTitleEn")}</Field>
        </div>
      </Section>

      <Section icon={<FileText size={15} />} title="页脚 · 公司信息" sub="首页、服务页、服务中心与企业资质页统一显示" onReset={() => restoreSection("footer")} disabled={saving}>
        <div className="admin-settings-grid">
          <Field label="页脚品牌(中文)">{I("footer.brand")}</Field>
          <Field label="页脚品牌(英文)">{I("footer.brandEn")}</Field>
          <Field full label="公司地址(中文)">{I("footer.address")}</Field>
          <Field full label="公司地址(英文)">{I("footer.addressEn")}</Field>
          <Field full label="版权信息">{I("footer.copyright")}</Field>
        </div>
      </Section>

      <Section icon={<Bell size={15} />} title="通知" sub="Telegram Bot 凭据仍由环境变量管理，不会暴露到前台" onReset={() => restoreSection("notify")} disabled={saving}>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
          <label className="admin-settings-check">
            <input type="checkbox" checked={!!s.notify.telegramEnabled} onChange={(e) => set("notify.telegramEnabled", e.target.checked)} />
            订单与运营 Telegram 通知
          </label>
          <label className="admin-settings-check">
            <input type="checkbox" checked={!!s.notify.telegramWithdrawEnabled} onChange={(e) => set("notify.telegramWithdrawEnabled", e.target.checked)} />
            提现申请 Telegram 通知
          </label>
        </div>
      </Section>

      <Section icon={<Server size={15} />} title="机场节点面板 · 自动开通" sub="订单标记完成后，按订单号在面板开号并套用套餐；令牌仅服务端使用，不会出现在前台接口" onReset={() => restoreSection("nodePanel")} disabled={saving}>
        <label className="admin-settings-check" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={!!s.nodePanel.enabled} onChange={(e) => set("nodePanel.enabled", e.target.checked)} />
          标记完成时自动在面板开通
        </label>
        <div className="admin-settings-grid">
          <Field full label="接口前缀">{I("nodePanel.apiBase", { placeholder: "https://hk.joinvip.vip:2053/ad/api/v1", autoComplete: "off", spellCheck: false })}</Field>
          <Field full label="外部 API 令牌">
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <div className="grow">{I("nodePanel.apiToken", { type: showPanelToken ? "text" : "password", placeholder: "在面板「管理员 → 外部 API」获取；更换令牌后在此更新即可", autoComplete: "new-password", spellCheck: false })}</div>
              <button type="button" className="admin-settings-btn" onClick={() => setShowPanelToken((v) => !v)}>{showPanelToken ? "隐藏" : "显示"}</button>
            </div>
          </Field>
          <Field label="普通套餐 → 面板套餐名">{I("nodePanel.planNames.basic", { autoComplete: "off" })}</Field>
          <Field label="高级套餐 → 面板套餐名">{I("nodePanel.planNames.pro", { autoComplete: "off" })}</Field>
          <Field label="豪华套餐 → 面板套餐名">{I("nodePanel.planNames.luxury", { autoComplete: "off" })}</Field>
          <Field label="无限套餐 → 面板套餐名">{I("nodePanel.planNames.unlimited", { autoComplete: "off" })}</Field>
          <Field label="10GB 测试 → 面板套餐名">{I("nodePanel.planNames.trial", { autoComplete: "off" })}</Field>
        </div>
        <div className="admin-node-panel-test">
          <button type="button" className="admin-settings-btn" onClick={testNodePanel} disabled={saving || panelTest?.state === "running"}>
            {panelTest?.state === "running"
              ? <><LoaderCircle size={13} className="spin-icon" />测试中</>
              : <><Activity size={13} />测试接口可用性</>}
          </button>
          {panelTest?.state === "done" && (
            <span className={`admin-node-panel-test-result ${panelTest.ok ? "ok" : "error"}`} role="status">
              {panelTest.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{panelTest.message}
            </span>
          )}
        </div>
        <small style={{ display: "block", marginTop: 8, color: "var(--muted)", fontSize: 11 }}>面板按套餐名称精确匹配（区分大小写）。测试读取的是<b>已保存</b>的配置，改完请先保存再测。每日维护任务会自动探测一次，不通会推送 Telegram 告警并记入系统健康。</small>
      </Section>
      </fieldset>

      <Section icon={<DatabaseBackup size={15} />} title="数据备份" sub="导出全部业务数据(订单/用户/兑换码/提现/售后工单/设置与目录覆盖/日志)为 JSON 文件,建议定期下载留存;不含访客埋点">
        <a href="/api/admin/backup" className="admin-settings-btn" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <DatabaseBackup size={13} />下载全量备份
        </a>
      </Section>
    </div>
  );
}

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
