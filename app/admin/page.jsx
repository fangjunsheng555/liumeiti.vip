"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  ArrowLeft, ChevronDown, Copy, Eye, EyeOff,
  LoaderCircle, LogOut, Search, ShieldCheck,
  CheckCircle2, Clock, Inbox, X,
} from "lucide-react";

const STATUS_LABEL = {
  received: "订单已收到",
  completed: "订单已完成",
};

function copyText(text) {
  if (typeof window === "undefined") return;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

export default function AdminPage() {
  const [authed, setAuthed] = useState(null); // null=loading, false=login, true=ok
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filterStatus, setFilterStatus] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [activeOrder, setActiveOrder] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [showPwds, setShowPwds] = useState({});

  // Try fetching orders to detect if authed
  const loadOrders = useCallback(async (q, status) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (status && status !== "all") params.set("status", status);
      const res = await fetch("/api/admin/orders?" + params.toString(), { credentials: "same-origin" });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const data = await res.json();
      if (data.ok) {
        setOrders(data.orders || []);
        setAuthed(true);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOrders(appliedSearch, filterStatus);
  }, [loadOrders, appliedSearch, filterStatus]);

  async function doLogin(e) {
    e.preventDefault();
    if (loggingIn) return;
    setLoggingIn(true);
    setLoginError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.ok) {
        setAuthed(true);
        setPassword("");
        loadOrders(appliedSearch, filterStatus);
      } else {
        setLoginError(data.error === "invalid_password" ? "密码错误" : (data.error || "登录失败"));
      }
    } catch (e) {
      setLoginError("网络错误");
    } finally {
      setLoggingIn(false);
    }
  }

  async function doLogout() {
    await fetch("/api/admin/login", { method: "DELETE" });
    setAuthed(false);
    setOrders([]);
  }

  function openOrder(order) {
    setActiveOrder(order);
    setEditForm({
      status: order.status,
      staffNotes: order.staffNotes || "",
      items: order.items.map((it) => ({
        index: order.items.indexOf(it),
        service: it.service,
        label: it.label,
        account: it.account || "",
        password: it.password || "",
        staffAccount: it.staffAccount || "",
        staffPassword: it.staffPassword || "",
      })),
    });
    setSaveResult(null);
  }

  function updateItem(idx, field, value) {
    setEditForm((cur) => ({
      ...cur,
      items: cur.items.map((it, i) => i === idx ? { ...it, [field]: value } : it),
    }));
  }

  async function saveOrder() {
    if (!activeOrder || saving) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(activeOrder.orderId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          status: editForm.status,
          staffNotes: editForm.staffNotes,
          items: editForm.items.map((it) => ({
            index: it.index,
            account: it.account,
            password: it.password,
            staffAccount: it.staffAccount,
            staffPassword: it.staffPassword,
          })),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaveResult({ type: "success", message: "已保存" + (data.completion?.email?.ok ? " · 完成邮件已发送" : data.completion ? " · 邮件发送失败" : "") });
        loadOrders(appliedSearch, filterStatus);
        setActiveOrder(data.order);
      } else {
        setSaveResult({ type: "error", message: data.error || "保存失败" });
      }
    } catch (e) {
      setSaveResult({ type: "error", message: "网络错误" });
    } finally {
      setSaving(false);
    }
  }

  // ── Login screen ──
  if (authed === false) {
    return (
      <div className="admin-login-page">
        <div className="admin-login-card">
          <div className="admin-login-icon"><ShieldCheck size={28} /></div>
          <h1>工作后台</h1>
          <p>请输入管理员密码</p>
          {loginError && <div className="admin-alert error">{loginError}</div>}
          <form onSubmit={doLogin}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="管理员密码"
              autoFocus
              required
            />
            <button type="submit" disabled={loggingIn || !password}>
              {loggingIn ? <><LoaderCircle size={14} className="spin-icon" />登录中</> : "登录"}
            </button>
          </form>
          <Link href="/" className="admin-back-link"><ArrowLeft size={13} />返回首页</Link>
        </div>
      </div>
    );
  }

  // ── Loading ──
  if (authed === null) {
    return <div className="admin-loading"><LoaderCircle size={28} className="spin-icon" /></div>;
  }

  // ── Dashboard ──
  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-left">
          <Link href="/"><img src="/logo.png" alt="冒央会社" className="admin-logo" /></Link>
          <span className="admin-tag">工作后台</span>
        </div>
        <button type="button" className="admin-logout" onClick={doLogout}>
          <LogOut size={14} />退出
        </button>
      </header>

      <main className="admin-main">
        <div className="admin-toolbar">
          <form
            className="admin-search"
            onSubmit={(e) => { e.preventDefault(); setAppliedSearch(searchInput); }}
          >
            <Search size={14} />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="订单号 / 邮箱 / 联系方式"
            />
            <button type="submit">搜索</button>
          </form>
          <div className="admin-filter">
            {[
              { v: "all", label: "全部" },
              { v: "received", label: "未完成" },
              { v: "completed", label: "已完成" },
            ].map((f) => (
              <button
                key={f.v}
                type="button"
                className={`admin-filter-btn${filterStatus === f.v ? " active" : ""}`}
                onClick={() => setFilterStatus(f.v)}
              >{f.label}</button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="admin-loading-inline"><LoaderCircle size={20} className="spin-icon" />加载中</div>
        ) : orders.length === 0 ? (
          <div className="admin-empty"><Inbox size={36} /><p>暂无订单</p></div>
        ) : (
          <div className="admin-orders">
            {orders.map((o) => (
              <button
                key={o.orderId}
                type="button"
                className={`admin-order-card status-${o.status}`}
                onClick={() => openOrder(o)}
              >
                <div className="admin-order-top">
                  <span className="admin-order-id">{o.orderId}</span>
                  <span className={`admin-order-status status-${o.status}`}>
                    {o.status === "completed" ? <CheckCircle2 size={11} /> : <Clock size={11} />}
                    {STATUS_LABEL[o.status]}
                  </span>
                </div>
                <div className="admin-order-mid">
                  <span className="admin-order-service">{o.serviceLabel}</span>
                  {o.itemCount > 1 && <span className="admin-order-count">{o.itemCount} 件</span>}
                </div>
                <div className="admin-order-bot">
                  <span className="admin-order-paid">
                    {o.paidCurrency === "USDT" ? `${o.paidAmount} USDT` : `¥${o.paidAmount}`}
                  </span>
                  <span className="admin-order-time">{o.createdAtBeijing?.split(" ")[1] || ""}</span>
                </div>
                <div className="admin-order-email">{o.email}</div>
              </button>
            ))}
          </div>
        )}
      </main>

      {/* Edit modal */}
      {activeOrder && editForm && (
        <div className="admin-modal-mask" onClick={() => !saving && setActiveOrder(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">{activeOrder.orderId}</div>
                <div className={`admin-modal-status status-${activeOrder.status}`}>
                  {activeOrder.status === "completed" ? <CheckCircle2 size={12} /> : <Clock size={12} />}
                  {STATUS_LABEL[activeOrder.status]}
                </div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => !saving && setActiveOrder(null)} disabled={saving}>
                <X size={16} />
              </button>
            </div>

            <div className="admin-modal-body">
              {/* Order summary */}
              <section className="admin-modal-section">
                <h3>订单概览</h3>
                <div className="admin-summary-grid">
                  <div><span>下单时间</span><b>{activeOrder.createdAtBeijing}</b></div>
                  <div><span>支付方式</span><b>{activeOrder.paymentMethod === "usdt" ? "USDT-TRC20" : "支付宝"}</b></div>
                  <div><span>实付金额</span><b>{activeOrder.paidCurrency === "USDT" ? `${activeOrder.paidAmount} USDT` : `¥${activeOrder.paidAmount}`}</b></div>
                  <div><span>件数</span><b>{activeOrder.itemCount} 件</b></div>
                  <div><span>邮箱</span>
                    <b>
                      {activeOrder.email}
                      <button type="button" className="admin-mini-copy" onClick={() => copyText(activeOrder.email)}><Copy size={11} /></button>
                    </b>
                  </div>
                  <div><span>联系方式</span>
                    <b>
                      {activeOrder.contact}
                      <button type="button" className="admin-mini-copy" onClick={() => copyText(activeOrder.contact)}><Copy size={11} /></button>
                    </b>
                  </div>
                  {activeOrder.remark && (
                    <div className="span-2"><span>买家备注</span><b className="admin-summary-remark">{activeOrder.remark}</b></div>
                  )}
                  {activeOrder.completedAtBeijing && (
                    <div className="span-2"><span>完成时间</span><b>{activeOrder.completedAtBeijing}</b></div>
                  )}
                </div>
              </section>

              {/* Items */}
              <section className="admin-modal-section">
                <h3>商品配置 · {editForm.items.length} 件</h3>
                {editForm.items.map((it, idx) => {
                  const isStaffFill = it.service !== "spotify" && it.service !== "rocket"; // netflix/disney/max
                  return (
                    <div key={idx} className="admin-item-card">
                      <div className="admin-item-head">
                        <strong>{idx + 1}. {it.label}</strong>
                        <span className="admin-item-tag">{isStaffFill ? "客服填写账号密码" : "可修改买家输入"}</span>
                      </div>
                      {isStaffFill ? (
                        <>
                          <label className="admin-field">
                            <span>账号 <em>*</em></span>
                            <input
                              value={it.staffAccount}
                              onChange={(e) => updateItem(idx, "staffAccount", e.target.value)}
                              placeholder="工作人员填写要发给买家的账号"
                            />
                          </label>
                          <label className="admin-field">
                            <span>密码 <em>*</em></span>
                            <div className="admin-pwd-wrap">
                              <input
                                type={showPwds[idx] ? "text" : "password"}
                                value={it.staffPassword}
                                onChange={(e) => updateItem(idx, "staffPassword", e.target.value)}
                                placeholder="工作人员填写密码"
                              />
                              <button type="button" onClick={() => setShowPwds((s) => ({ ...s, [idx]: !s[idx] }))}>
                                {showPwds[idx] ? <EyeOff size={14} /> : <Eye size={14} />}
                              </button>
                            </div>
                          </label>
                        </>
                      ) : (
                        <>
                          <label className="admin-field">
                            <span>{it.service === "rocket" ? "用户名(可改)" : "账号(可改)"}</span>
                            <input
                              value={it.account}
                              onChange={(e) => updateItem(idx, "account", e.target.value)}
                            />
                          </label>
                          {it.service === "spotify" && (
                            <label className="admin-field">
                              <span>密码(可改)</span>
                              <div className="admin-pwd-wrap">
                                <input
                                  type={showPwds[idx] ? "text" : "password"}
                                  value={it.password}
                                  onChange={(e) => updateItem(idx, "password", e.target.value)}
                                />
                                <button type="button" onClick={() => setShowPwds((s) => ({ ...s, [idx]: !s[idx] }))}>
                                  {showPwds[idx] ? <EyeOff size={14} /> : <Eye size={14} />}
                                </button>
                              </div>
                            </label>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </section>

              <section className="admin-modal-section">
                <h3>客服备注(发到买家邮件)</h3>
                <textarea
                  className="admin-notes"
                  value={editForm.staffNotes}
                  onChange={(e) => setEditForm({ ...editForm, staffNotes: e.target.value })}
                  rows={3}
                  placeholder="例如:位置 3,初始密码已修改;如需切换地区请联系客服。"
                />
              </section>

              {saveResult && <div className={`admin-alert ${saveResult.type}`}>{saveResult.message}</div>}

              <div className="admin-actions">
                <select
                  className="admin-status-select"
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                  disabled={saving}
                >
                  <option value="received">订单已收到</option>
                  <option value="completed">订单已完成(发开通邮件)</option>
                </select>
                <button
                  type="button"
                  className="admin-save-btn"
                  onClick={saveOrder}
                  disabled={saving}
                >
                  {saving ? <><LoaderCircle size={14} className="spin-icon" />保存中</> : "保存修改"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
