"use client";

// 站点设置 — 仅超级管理员。读写 /api/admin/settings。
// 改任何项,保存后前端站点(客服/服务中心/页脚/收款码/结账)与订单邮件即时同步。
import { useEffect, useState, useCallback } from "react";
import { LoaderCircle, Save, RotateCcw, Settings as SettingsIcon, AlertTriangle, CheckCircle2, Headphones, Coins, Layers, QrCode, Tag, FileText, Bell, Upload } from "lucide-react";

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
function QrField({ label, path, fallback, value, set, setMsg }) {
  const inputId = "qr-upload-" + path.replace(/\W/g, "-");
  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\//.test(file.type)) { setMsg({ type: "error", text: "请选择图片文件" }); return; }
    if (file.size > 8 * 1024 * 1024) { setMsg({ type: "error", text: "图片过大(超过 8MB)" }); return; }
    try {
      const out = await compressImage(file);
      set(path, out);
      setMsg({ type: "ok", text: `${label}已就绪(已压缩),点右上角「保存」生效` });
    } catch (err) {
      setMsg({ type: "error", text: "图片处理失败,请换一张试试" });
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
    </div>
  );
}

function Section({ icon, title, sub, children }) {
  return (
    <div className="admin-settings-section">
      <div className="admin-settings-section-title"><span className="ico">{icon}</span>{title}</div>
      {sub && <div className="admin-settings-section-sub">{sub}</div>}
      {children}
    </div>
  );
}
function Field({ label, full, children }) {
  return <div className={`admin-settings-field${full ? " full" : ""}`}><label>{label}</label>{children}</div>;
}

export default function SettingsPanel() {
  const [s, setS] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/settings", { credentials: "same-origin", cache: "no-store" });
      const j = await r.json();
      if (j.ok) setS(j.settings);
      else setMsg({ type: "error", text: j.error === "unauthorized" ? "仅超级管理员可管理站点设置" : (j.error || "加载失败") });
    } catch (e) { setMsg({ type: "error", text: "网络错误" }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function set(path, value) {
    setS((cur) => {
      const next = JSON.parse(JSON.stringify(cur));
      let o = next; const ks = path.split(".");
      for (let i = 0; i < ks.length - 1; i += 1) o = o[ks[i]];
      o[ks[ks.length - 1]] = value;
      return next;
    });
  }
  const I = (path, props = {}) => <input value={s ? get(s, path) ?? "" : ""} onChange={(e) => set(path, e.target.value)} {...props} />;

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/settings", {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: s }),
      });
      const j = await r.json();
      if (j.ok) { setS(j.settings); setMsg({ type: "ok", text: "已保存 · 站点客服/服务中心/页脚/收款码/结账与订单邮件即时同步" }); }
      else setMsg({ type: "error", text: j.error || "保存失败" });
    } catch (e) { setMsg({ type: "error", text: "网络错误" }); }
    finally { setSaving(false); }
  }

  if (loading && !s) return <div style={{ display: "inline-flex", gap: 8, alignItems: "center", color: "var(--muted)", fontSize: 13 }}><LoaderCircle size={16} className="spin-icon" />加载设置…</div>;
  if (!s) return msg ? <div className="admin-settings-alert error"><AlertTriangle size={15} />{msg.text}</div> : null;

  // 组合优惠 tier 是「折扣额」(0.05=5% off=9.5折);USDT discount 是「实付倍率」(0.9=付9成=10% off=9折)
  const bundlePct = (v) => `${Math.round(Number(v || 0) * 100)}% off · ${(10 * (1 - Number(v || 0))).toFixed(1)}折`;
  const usdtPct = (v) => `${Math.round((1 - Number(v || 0)) * 100)}% off · ${(10 * Number(v || 0)).toFixed(1)}折`;

  return (
    <div className="admin-settings">
      <div className="admin-settings-head">
        <h2><SettingsIcon size={19} />站点设置</h2>
        <span className="sub">改完保存,前端站点与结账/邮件即时同步</span>
        <span className="spacer" />
        <button type="button" className="admin-settings-btn" onClick={load} disabled={saving}><RotateCcw size={13} />重载</button>
        <button type="button" className="admin-settings-btn primary" onClick={save} disabled={saving}>
          {saving ? <LoaderCircle size={14} className="spin-icon" /> : <Save size={14} />}{saving ? "保存中" : "保存全部"}
        </button>
      </div>
      {msg && <div className={`admin-settings-alert ${msg.type}`}>{msg.type === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{msg.text}</div>}

      <Section icon={<Headphones size={15} />} title="客服联系方式" sub="浮动客服按钮 + 服务中心 + 订单邮件共用">
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

      <Section icon={<Coins size={15} />} title="USDT 结算" sub="收款地址、支付折扣、汇率(留空=每日自动)">
        <div className="admin-settings-grid">
          <Field full label="TRC20 收款地址">{I("usdt.address")}</Field>
          <Field label={`USDT 折扣率 实付倍率(${usdtPct(s.usdt.discount)})`}><input type="number" step="0.01" min="0.1" max="1" value={s.usdt.discount} onChange={(e) => set("usdt.discount", Number(e.target.value))} /></Field>
          <Field label="固定汇率(留空=每日自动)">{I("usdt.rateOverride", { placeholder: "自动", inputMode: "decimal" })}</Field>
        </div>
        <label className="admin-settings-check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={!!s.usdt.autoConfirm} onChange={(e) => set("usdt.autoConfirm", e.target.checked)} />
          开启 TRON 链上自动确认到账
        </label>
        <div className="admin-settings-hint">每笔 USDT 订单会生成唯一精确金额，仅确认已上链交易，不自动发货。开启前请先完成一笔真实小额测试。</div>
      </Section>

      <Section icon={<Layers size={15} />} title="组合优惠档位" sub="多件下单自动打折,结账实收价即时跟随">
        <div className="admin-settings-grid">
          <Field label={`满 2 件折扣(${bundlePct(s.bundle.tier2Rate)})`}><input type="number" step="0.01" min="0" max="0.9" value={s.bundle.tier2Rate} onChange={(e) => set("bundle.tier2Rate", Number(e.target.value))} /></Field>
          <Field label={`满 3 件折扣(${bundlePct(s.bundle.tier3Rate)})`}><input type="number" step="0.01" min="0" max="0.9" value={s.bundle.tier3Rate} onChange={(e) => set("bundle.tier3Rate", Number(e.target.value))} /></Field>
        </div>
        <div className="admin-settings-hint">填「折扣额」:0.05 = 5% off = 9.5 折;0.10 = 10% off = 9 折;0 = 无折扣。</div>
      </Section>

      <Section icon={<QrCode size={15} />} title="收款二维码" sub="支付宝 + USDT 收款码 — 点「上传图片」直接换图(自动压缩),或填路径/URL">
        <div className="admin-settings-grid">
          <QrField label="支付宝收款码" path="payment.alipayQr" fallback="/payment/alipay.jpg" value={s.payment.alipayQr} set={set} setMsg={setMsg} />
          <QrField label="USDT 收款码" path="payment.usdtQr" fallback="/payment/usdt.png" value={s.payment.usdtQr} set={set} setMsg={setMsg} />
        </div>
      </Section>

      <Section icon={<Tag size={15} />} title="品牌 / 站点标题" sub="用于订单邮件、浏览器标签标题">
        <div className="admin-settings-grid">
          <Field label="品牌名(中文)">{I("brand.name")}</Field>
          <Field label="品牌名(英文)">{I("brand.nameEn")}</Field>
          <Field full label="站点标题(中文)">{I("brand.siteTitle")}</Field>
          <Field full label="站点标题(英文)">{I("brand.siteTitleEn")}</Field>
        </div>
      </Section>

      <Section icon={<FileText size={15} />} title="页脚 · 公司信息" sub="首页 / 服务页页脚显示">
        <div className="admin-settings-grid">
          <Field label="页脚品牌(中文)">{I("footer.brand")}</Field>
          <Field label="页脚品牌(英文)">{I("footer.brandEn")}</Field>
          <Field full label="公司地址(中文)">{I("footer.address")}</Field>
          <Field full label="公司地址(英文)">{I("footer.addressEn")}</Field>
          <Field full label="版权信息">{I("footer.copyright")}</Field>
        </div>
      </Section>

      <Section icon={<Bell size={15} />} title="通知" sub="Telegram 推送(bot token/chat id 在环境变量,不经前端)">
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
          <label className="admin-settings-check">
            <input type="checkbox" checked={!!s.notify.telegramEnabled} onChange={(e) => set("notify.telegramEnabled", e.target.checked)} />
            新订单 Telegram 通知
          </label>
          <label className="admin-settings-check">
            <input type="checkbox" checked={!!s.notify.telegramWithdrawEnabled} onChange={(e) => set("notify.telegramWithdrawEnabled", e.target.checked)} />
            提现申请 Telegram 通知
          </label>
        </div>
      </Section>
    </div>
  );
}

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
