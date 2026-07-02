"use client";

// 安全中心 — 所有后台账号可用:绑定/解绑自己的两步验证(TOTP);超管另见登录日志。
import { useEffect, useState, useCallback } from "react";
import { LoaderCircle, ShieldCheck, KeyRound, Copy, CheckCircle2, AlertTriangle, ScrollText, RefreshCw } from "lucide-react";
import QRCode from "qrcode";

function copy(text) {
  try { navigator.clipboard?.writeText(text); } catch (e) {}
}

export default function SecurityPanel({ isRoot }) {
  const [status, setStatus] = useState(null); // { enabled, remainingBackup, globallyDisabled }
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [pending, setPending] = useState(null); // { secret, otpauth }
  const [qrUrl, setQrUrl] = useState("");       // otpauth 二维码 dataURL
  const [code, setCode] = useState("");
  const [regenCode, setRegenCode] = useState(""); // 重新生成备用码用的动态码
  const [backupCodes, setBackupCodes] = useState(null); // 一次性展示
  const [copied, setCopied] = useState("");
  const [loginLog, setLoginLog] = useState(null);

  // 绑定流程:otpauth 链接生成扫码二维码
  useEffect(() => {
    let on = true;
    if (pending?.otpauth) {
      QRCode.toDataURL(pending.otpauth, { width: 220, margin: 1, errorCorrectionLevel: "M" })
        .then((url) => { if (on) setQrUrl(url); })
        .catch(() => { if (on) setQrUrl(""); });
    } else {
      setQrUrl("");
    }
    return () => { on = false; };
  }, [pending?.otpauth]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/2fa", { credentials: "same-origin", cache: "no-store" });
      const j = await r.json();
      if (j.ok) setStatus(j);
    } catch (e) {}
  }, []);
  const loadLog = useCallback(async () => {
    if (!isRoot) return;
    try {
      const r = await fetch("/api/admin/login-log", { credentials: "same-origin", cache: "no-store" });
      const j = await r.json();
      if (j.ok) setLoginLog(j.entries || []);
    } catch (e) {}
  }, [isRoot]);
  useEffect(() => { load(); loadLog(); }, [load, loadLog]);

  async function act(action, extra = {}) {
    setBusy(action); setMsg(null);
    try {
      const r = await fetch("/api/admin/2fa", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const j = await r.json();
      if (!j.ok) {
        setMsg({ type: "error", text: j.error === "invalid_code" ? "动态码错误,请确认手机时间准确后重试" : (j.error || "操作失败") });
        return null;
      }
      return j;
    } catch (e) { setMsg({ type: "error", text: "网络错误" }); return null; }
    finally { setBusy(""); }
  }

  async function begin() {
    const j = await act("begin");
    if (j) { setPending({ secret: j.secret, otpauth: j.otpauth }); setCode(""); }
  }
  async function confirm() {
    const j = await act("confirm", { code });
    if (j) {
      setPending(null); setCode(""); setBackupCodes(j.backupCodes || []);
      setMsg({ type: "ok", text: "两步验证已启用 · 下面的备用恢复码只显示这一次,请立即保存" });
      load();
    }
  }
  async function disable() {
    if (typeof window !== "undefined" && !window.confirm("确认关闭两步验证?关闭后仅密码即可登录。")) return;
    const j = await act("disable", { code });
    if (j) { setCode(""); setBackupCodes(null); setMsg({ type: "ok", text: "两步验证已关闭" }); load(); }
  }
  async function regen() {
    const j = await act("regen", { code: regenCode });
    if (j) {
      setRegenCode(""); setBackupCodes(j.backupCodes || []);
      setMsg({ type: "ok", text: "新备用码已生成(旧备用码全部作废)· 只显示这一次,请立即保存" });
      load();
    }
  }
  function doCopy(key, text) { copy(text); setCopied(key); setTimeout(() => setCopied(""), 1500); }

  return (
    <div className="admin-settings">
      <div className="admin-settings-head">
        <h2><ShieldCheck size={19} />安全中心</h2>
        <span className="sub">两步验证保护后台登录{isRoot ? " · 登录日志" : ""}</span>
      </div>
      {msg && <div className={`admin-settings-alert ${msg.type}`}>{msg.type === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{msg.text}</div>}

      <div className="admin-settings-section">
        <div className="admin-settings-section-title"><span className="ico"><KeyRound size={15} /></span>我的两步验证(TOTP)</div>
        <div className="admin-settings-section-sub">绑定后登录需输入验证器动态码;支持 Google Authenticator / 1Password / 本站工具箱 2FA 等</div>

        {!status ? (
          <div style={{ color: "var(--muted)", fontSize: 13 }}><LoaderCircle size={14} className="spin-icon" /> 加载中…</div>
        ) : status.globallyDisabled ? (
          <div className="admin-settings-alert error"><AlertTriangle size={15} />环境变量 ADMIN_2FA_DISABLE=1 生效中,两步验证被全局跳过(紧急兜底模式)。</div>
        ) : status.enabled && !backupCodes ? (
          <>
            <div className="admin-2fa-status on"><CheckCircle2 size={15} />已启用 · 剩余备用恢复码 {status.remainingBackup} 个{status.remainingBackup <= 3 ? "(偏少,建议重新生成)" : ""}</div>
            <div className="admin-settings-grid" style={{ marginTop: 10 }}>
              <div className="admin-settings-field">
                <label>重新生成备用码(输入动态码验证)</label>
                <input inputMode="numeric" value={regenCode} onChange={(e) => setRegenCode(e.target.value.slice(0, 12))} placeholder="6 位动态码" />
              </div>
              <div className="admin-settings-field" style={{ display: "flex", alignItems: "flex-end" }}>
                <button type="button" className="admin-settings-btn" onClick={regen} disabled={busy || !regenCode}>
                  {busy === "regen" ? <LoaderCircle size={13} className="spin-icon" /> : <RefreshCw size={13} />}重新生成备用码
                </button>
              </div>
              <div className="admin-settings-field">
                <label>输入动态码(或备用码)以关闭</label>
                <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.slice(0, 12))} placeholder="6 位动态码" />
              </div>
              <div className="admin-settings-field" style={{ display: "flex", alignItems: "flex-end" }}>
                <button type="button" className="admin-settings-btn" onClick={disable} disabled={busy || !code}>
                  {busy === "disable" ? <LoaderCircle size={13} className="spin-icon" /> : null}关闭两步验证
                </button>
              </div>
            </div>
          </>
        ) : backupCodes ? (
          <div className="admin-2fa-backup">
            <div className="admin-2fa-backup-title"><AlertTriangle size={14} />备用恢复码(每个只能用一次,丢手机时代替动态码登录)——只显示这一次:</div>
            <div className="admin-2fa-backup-grid">
              {backupCodes.map((c) => <code key={c}>{c}</code>)}
            </div>
            <button type="button" className="admin-settings-btn" onClick={() => doCopy("backup", backupCodes.join("\n"))}>
              <Copy size={13} />{copied === "backup" ? "已复制" : "复制全部备用码"}
            </button>
          </div>
        ) : pending ? (
          <>
            <div className="admin-2fa-bind">
              <div className="admin-2fa-step">1. 打开验证器 App(Google Authenticator / 本站工具箱 2FA)扫描二维码,或手动输入密钥:</div>
              <div className="admin-2fa-qr-row">
                {qrUrl ? (
                  <img className="admin-2fa-qr" src={qrUrl} alt="2FA 绑定二维码" width={170} height={170} />
                ) : (
                  <div className="admin-2fa-qr admin-2fa-qr-loading"><LoaderCircle size={18} className="spin-icon" /></div>
                )}
                <div className="admin-2fa-qr-side">
                  <div className="admin-2fa-secret">
                    <code>{pending.secret}</code>
                    <button type="button" className="admin-settings-btn" onClick={() => doCopy("secret", pending.secret)}><Copy size={13} />{copied === "secret" ? "已复制" : "复制密钥"}</button>
                  </div>
                  <div className="admin-2fa-secret">
                    <code style={{ fontSize: 10.5 }}>{pending.otpauth}</code>
                    <button type="button" className="admin-settings-btn" onClick={() => doCopy("uri", pending.otpauth)}><Copy size={13} />{copied === "uri" ? "已复制" : "复制链接"}</button>
                  </div>
                </div>
              </div>
              <div className="admin-2fa-step">2. 输入验证器显示的 6 位动态码完成绑定:</div>
              <div className="admin-settings-grid">
                <div className="admin-settings-field">
                  <input inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位动态码" />
                </div>
                <div className="admin-settings-field" style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                  <button type="button" className="admin-settings-btn primary" onClick={confirm} disabled={busy || code.length !== 6}>
                    {busy === "confirm" ? <LoaderCircle size={13} className="spin-icon" /> : <CheckCircle2 size={13} />}确认启用
                  </button>
                  <button type="button" className="admin-settings-btn" onClick={() => { setPending(null); setCode(""); }}>取消</button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="admin-2fa-status off"><AlertTriangle size={15} />未启用 —— 仅密码即可登录后台,建议立即开启</div>
            <button type="button" className="admin-settings-btn primary" style={{ marginTop: 10 }} onClick={begin} disabled={Boolean(busy)}>
              {busy === "begin" ? <LoaderCircle size={13} className="spin-icon" /> : <ShieldCheck size={13} />}开启两步验证
            </button>
          </>
        )}
      </div>

      {isRoot && (
        <div className="admin-settings-section">
          <div className="admin-settings-section-title"><span className="ico"><ScrollText size={15} /></span>登录日志<span style={{ fontWeight: 500, fontSize: 12, color: "var(--faint)" }}>(最近 100 条,成功/失败均记录)</span></div>
          <div className="admin-login-log">
            {loginLog === null ? (
              <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}><LoaderCircle size={14} className="spin-icon" /> 加载中…</div>
            ) : loginLog.length === 0 ? (
              <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>暂无记录</div>
            ) : loginLog.map((e) => (
              <div key={e.id} className={`admin-login-log-row${e.ok ? "" : " fail"}`}>
                <span className="t">{e.createdAtBeijing}</span>
                <b>{e.username || "?"}</b>
                <span className={`r ${e.ok ? "ok" : "no"}`}>{e.ok ? "成功" : (e.reason === "wrong_password" ? "密码错误" : e.reason === "wrong_2fa" ? "动态码错误" : "失败")}</span>
                <span className="ip">{e.ip}</span>
                <span className="ua" title={e.userAgent}>{e.userAgent}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
