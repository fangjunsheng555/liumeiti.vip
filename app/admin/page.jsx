"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  ArrowLeft, ChevronDown, Copy, Eye, EyeOff,
  LoaderCircle, LogOut, Search, ShieldCheck,
  CheckCircle2, Clock, Inbox, X, AlertTriangle, Trash2,
} from "lucide-react";

const STATUS_LABEL = {
  received: "订单已收到",
  completed: "订单已完成",
  invalid: "无效·未收到付款",
};

const STATUS_ICON_KEY = {
  received: "clock",
  completed: "check",
  invalid: "x",
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
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [showPwds, setShowPwds] = useState({});

  // Batch selection state
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResult, setBatchResult] = useState(null);
  const [batchConfirm, setBatchConfirm] = useState(null); // null | "delete" | "invalid"

  // User/balance management
  const [tab, setTab] = useState("orders"); // "orders" | "users"
  const [userQuery, setUserQuery] = useState("");
  const [userInfo, setUserInfo] = useState(null); // {user, transactions}
  const [userLoading, setUserLoading] = useState(false);
  const [userError, setUserError] = useState("");
  const [balForm, setBalForm] = useState({ amount: "", reason: "" });
  const [balBusy, setBalBusy] = useState(false);
  const [balResult, setBalResult] = useState(null);
  const [globalLog, setGlobalLog] = useState({ entries: [], total: 0, totalAdded: 0, totalDeducted: 0, adminCount: 0, orderCount: 0 });
  const [logFilter, setLogFilter] = useState("all"); // all | add | deduct
  const [logSource, setLogSource] = useState("all"); // all | admin | order
  const [logQuery, setLogQuery] = useState("");
  const [logLoading, setLogLoading] = useState(false);

  // All registered users
  const [allUsers, setAllUsers] = useState({ users: [], total: 0 });
  const [userListQuery, setUserListQuery] = useState("");
  const [userListLoading, setUserListLoading] = useState(false);

  const loadGlobalLog = useCallback(async (q, filter, source) => {
    setLogLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (filter && filter !== "all") params.set("filter", filter);
      if (source && source !== "all") params.set("source", source);
      const res = await fetch("/api/admin/balance-log?" + params.toString(), { credentials: "same-origin" });
      const data = await res.json();
      if (data.ok) {
        setGlobalLog({
          entries: data.entries || [],
          total: data.total || 0,
          totalAdded: data.totalAdded || 0,
          totalDeducted: data.totalDeducted || 0,
          adminCount: data.adminCount || 0,
          orderCount: data.orderCount || 0,
        });
      }
    } catch (e) {} finally {
      setLogLoading(false);
    }
  }, []);

  const loadAllUsers = useCallback(async (q) => {
    setUserListLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      const res = await fetch("/api/admin/users/list?" + params.toString(), { credentials: "same-origin" });
      const data = await res.json();
      if (data.ok) {
        setAllUsers({ users: data.users || [], total: data.total || 0 });
      }
    } catch (e) {} finally {
      setUserListLoading(false);
    }
  }, []);

  // Load global log + user list when entering the users tab
  useEffect(() => {
    if (authed && tab === "users") {
      loadGlobalLog(logQuery, logFilter, logSource);
      loadAllUsers(userListQuery);
    }
  }, [authed, tab, loadGlobalLog, loadAllUsers, logFilter, logSource]);

  async function loadUser(email) {
    if (!email) return;
    setUserLoading(true);
    setUserError("");
    setBalResult(null);
    try {
      const res = await fetch(`/api/admin/users?email=${encodeURIComponent(email.trim())}`, {
        credentials: "same-origin",
      });
      const data = await res.json();
      if (data.ok) {
        setUserInfo(data);
      } else {
        setUserInfo(null);
        setUserError(data.error === "user_not_found" ? "未找到该邮箱的注册用户" : (data.error || "查询失败"));
      }
    } catch (e) {
      setUserError("网络错误");
    } finally {
      setUserLoading(false);
    }
  }

  async function refreshAfterAdjust() {
    // Re-load user view, global log, and user list
    if (userInfo) await loadUser(userInfo.user.email);
    await loadGlobalLog(logQuery, logFilter, logSource);
    await loadAllUsers(userListQuery);
  }

  async function adjustBalance(sign) {
    if (!userInfo || balBusy) return;
    const num = Number(balForm.amount);
    if (!Number.isFinite(num) || num <= 0) {
      setBalResult({ type: "error", message: "请输入正数金额" });
      return;
    }
    if (!balForm.reason.trim()) {
      setBalResult({ type: "error", message: "请填写原因(将记入余额明细)" });
      return;
    }
    setBalBusy(true);
    setBalResult(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: userInfo.user.email,
          amount: sign * num,
          reason: balForm.reason.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setBalResult({ type: "success", message: `已${sign > 0 ? "增加" : "扣除"} ¥${num.toFixed(2)} · 当前余额 ¥${data.balance.toFixed(2)}` });
        setBalForm({ amount: "", reason: "" });
        refreshAfterAdjust();
      } else {
        const msg = {
          insufficient_balance: "余额不足,无法扣除",
          user_not_found: "用户不存在",
          invalid_amount: "金额无效",
          reason_required: "请填写原因",
        }[data.error] || data.error || "操作失败";
        setBalResult({ type: "error", message: msg });
      }
    } catch (e) {
      setBalResult({ type: "error", message: "网络错误" });
    } finally {
      setBalBusy(false);
    }
  }

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
    setConfirmDelete(false);
  }

  function toggleBatchMode() {
    setBatchMode((v) => {
      const next = !v;
      if (!next) setSelectedIds(new Set());
      setBatchConfirm(null);
      setBatchResult(null);
      return next;
    });
  }

  function toggleSelect(orderId) {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds(new Set(orders.map((o) => o.orderId)));
  }

  function clearSelection() { setSelectedIds(new Set()); }

  async function executeBatch(action) {
    if (batchBusy) return;
    if (selectedIds.size === 0) {
      setBatchResult({ type: "error", message: "请先勾选订单" });
      return;
    }
    setBatchBusy(true);
    setBatchResult(null);
    try {
      const res = await fetch("/api/admin/orders/batch", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderIds: Array.from(selectedIds),
          action,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        const verb = action === "delete" ? "删除" : "标记为无效";
        setBatchResult({
          type: "success",
          message: `已${verb} ${data.successCount} 个订单${data.failedCount ? ` · ${data.failedCount} 个失败` : ""}`,
        });
        setSelectedIds(new Set());
        setBatchConfirm(null);
        loadOrders(appliedSearch, filterStatus);
      } else {
        setBatchResult({ type: "error", message: data.error || "批量操作失败" });
      }
    } catch (e) {
      setBatchResult({ type: "error", message: "网络错误" });
    } finally {
      setBatchBusy(false);
    }
  }

  async function deleteOrder() {
    if (!activeOrder || deleting) return;
    setDeleting(true);
    setSaveResult(null);
    try {
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(activeOrder.orderId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = await res.json();
      if (data.ok) {
        setActiveOrder(null);
        setEditForm(null);
        setConfirmDelete(false);
        loadOrders(appliedSearch, filterStatus);
      } else {
        setSaveResult({ type: "error", message: data.error || "删除失败" });
      }
    } catch (e) {
      setSaveResult({ type: "error", message: "网络错误" });
    } finally {
      setDeleting(false);
    }
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
        <div className="admin-tabs">
          <button type="button" className={`admin-tab-btn${tab === "orders" ? " active" : ""}`} onClick={() => setTab("orders")}>订单管理</button>
          <button type="button" className={`admin-tab-btn${tab === "users" ? " active" : ""}`} onClick={() => setTab("users")}>用户余额</button>
        </div>

        {tab === "users" ? (
          <div className="admin-users-pane">
            {/* All registered users */}
            <div className="admin-userlist">
              <div className="admin-userlist-head">
                <h3>全部注册用户 <em>{allUsers.total}</em></h3>
              </div>
              <form
                className="admin-search admin-search-mini"
                onSubmit={(e) => { e.preventDefault(); loadAllUsers(userListQuery); }}
              >
                <Search size={13} />
                <input
                  value={userListQuery}
                  onChange={(e) => setUserListQuery(e.target.value)}
                  placeholder="按用户名 / 邮箱搜索"
                />
                <button type="submit" disabled={userListLoading}>
                  {userListLoading ? <LoaderCircle size={11} className="spin-icon" /> : "搜索"}
                </button>
              </form>
              <div className="admin-userlist-body">
                {allUsers.users.length === 0 ? (
                  <div className="admin-userlist-empty">{userListLoading ? "加载中..." : "暂无用户"}</div>
                ) : allUsers.users.map((u) => (
                  <button
                    key={u.email}
                    type="button"
                    className="admin-userlist-item"
                    onClick={() => { setUserQuery(u.email); loadUser(u.email); }}
                  >
                    <span className="admin-userlist-name">{u.username || "—"}</span>
                    <span className="admin-userlist-email">{u.email}</span>
                    <span className="admin-userlist-balance">¥{u.balance.toFixed(2)}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* User detail / balance adjust */}
            <form
              className="admin-search"
              onSubmit={(e) => { e.preventDefault(); loadUser(userQuery); }}
            >
              <Search size={14} />
              <input
                type="email"
                inputMode="email"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="按注册邮箱查询用户"
              />
              <button type="submit" disabled={userLoading}>
                {userLoading ? <LoaderCircle size={12} className="spin-icon" /> : "查询"}
              </button>
            </form>

            {userError && <div className="admin-alert error" style={{ marginTop: 8 }}>{userError}</div>}

            {userInfo && (
              <>
                <div className="admin-user-card" style={{ marginTop: 10 }}>
                  <div className="admin-user-head">
                    <span className="admin-user-email">{userInfo.user.email}</span>
                    <span className="admin-user-balance">¥{userInfo.user.balance.toFixed(2)}</span>
                  </div>
                  <div className="admin-user-meta">注册于 {userInfo.user.createdAtBeijing || "—"}</div>
                </div>

                <div className="admin-balance-form">
                  <div className="admin-balance-row">
                    <span>金额(正数)</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0.01"
                      value={balForm.amount}
                      onChange={(e) => setBalForm({ ...balForm, amount: e.target.value })}
                      placeholder="例如 100"
                    />
                  </div>
                  <div className="admin-balance-row">
                    <span>原因(将记入余额明细)</span>
                    <textarea
                      value={balForm.reason}
                      onChange={(e) => setBalForm({ ...balForm, reason: e.target.value })}
                      placeholder="例如:充值 100;退款补偿;客服赠送"
                      rows={2}
                    />
                  </div>
                  {balResult && <div className={`admin-alert ${balResult.type}`}>{balResult.message}</div>}
                  <div className="admin-balance-actions">
                    <button type="button" className="admin-balance-add" disabled={balBusy} onClick={() => adjustBalance(+1)}>
                      <CheckCircle2 size={13} />增加余额
                    </button>
                    <button type="button" className="admin-balance-deduct" disabled={balBusy} onClick={() => adjustBalance(-1)}>
                      <AlertTriangle size={13} />扣除余额
                    </button>
                  </div>
                </div>

                <div className="admin-tx-list">
                  <div className="admin-tx-list-label">该用户余额明细 · {userInfo.transactions.length} 笔</div>
                  {userInfo.transactions.length === 0 ? (
                    <div className="admin-tx-item"><div className="admin-tx-item-info"><small>暂无变动记录</small></div></div>
                  ) : userInfo.transactions.map((tx) => (
                    <div key={tx.id} className={`admin-tx-item${tx.amount > 0 ? " positive" : " negative"}`}>
                      <div className="admin-tx-item-info">
                        <strong>{tx.reason}</strong>
                        <small>{tx.createdAtBeijing} · {tx.source === "admin" ? "工作人员调整" : tx.source === "order" ? `订单 ${tx.orderId || ""}` : ""}</small>
                      </div>
                      <div className="admin-tx-item-amount">{tx.amount > 0 ? "+" : ""}¥{Math.abs(tx.amount).toFixed(2)}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Global balance adjustment log — all users, all time */}
            <div className="admin-global-log">
              <div className="admin-global-log-head">
                <h3>全部余额变动记录</h3>
                <div className="admin-global-log-stats">
                  <span className="stat-add">累计加 <b>+¥{globalLog.totalAdded.toFixed(2)}</b></span>
                  <span className="stat-deduct">累计减 <b>−¥{globalLog.totalDeducted.toFixed(2)}</b></span>
                </div>
              </div>
              <div className="admin-global-log-toolbar">
                <form
                  className="admin-search admin-search-mini"
                  onSubmit={(e) => { e.preventDefault(); loadGlobalLog(logQuery, logFilter, logSource); }}
                >
                  <Search size={13} />
                  <input
                    value={logQuery}
                    onChange={(e) => setLogQuery(e.target.value)}
                    placeholder="按邮箱 / 原因 / 流水号搜索"
                  />
                  <button type="submit" disabled={logLoading}>
                    {logLoading ? <LoaderCircle size={11} className="spin-icon" /> : "搜索"}
                  </button>
                </form>
                <div className="admin-global-log-filters">
                  {[
                    { v: "all", label: "全部" },
                    { v: "add", label: "增加" },
                    { v: "deduct", label: "扣除" },
                  ].map((f) => (
                    <button
                      key={f.v}
                      type="button"
                      className={`admin-filter-btn${logFilter === f.v ? " active" : ""}`}
                      onClick={() => setLogFilter(f.v)}
                    >{f.label}</button>
                  ))}
                </div>
                <div className="admin-global-log-filters">
                  {[
                    { v: "all", label: `全部来源 (${globalLog.total})` },
                    { v: "admin", label: `工作人员 (${globalLog.adminCount})` },
                    { v: "order", label: `用户消费 (${globalLog.orderCount})` },
                  ].map((f) => (
                    <button
                      key={f.v}
                      type="button"
                      className={`admin-filter-btn${logSource === f.v ? " active" : ""}`}
                      onClick={() => setLogSource(f.v)}
                    >{f.label}</button>
                  ))}
                </div>
              </div>
              <div className="admin-tx-list">
                {globalLog.entries.length === 0 ? (
                  <div className="admin-tx-item"><div className="admin-tx-item-info"><small>暂无调整记录</small></div></div>
                ) : globalLog.entries.map((tx) => (
                  <div key={tx.id} className={`admin-tx-item admin-global-log-item${tx.amount > 0 ? " positive" : " negative"}`}>
                    <div className="admin-tx-item-info">
                      <div className="admin-global-log-row">
                        <strong>{tx.email}</strong>
                        <span className={`admin-source-tag source-${tx.source}`}>
                          {tx.source === "admin" ? "工作人员" : tx.source === "order" ? "用户消费" : "其他"}
                        </span>
                      </div>
                      <small>{tx.reason} · {tx.createdAtBeijing}</small>
                    </div>
                    <div className="admin-global-log-amounts">
                      <div className="admin-tx-item-amount">{tx.amount > 0 ? "+" : ""}¥{Math.abs(tx.amount).toFixed(2)}</div>
                      <small>余额 ¥{Number(tx.balanceAfter || 0).toFixed(2)}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
        <>
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
              { v: "invalid", label: "无效" },
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

        {/* Batch operations toolbar */}
        <div className="admin-batch-bar">
          <button
            type="button"
            className={`admin-batch-toggle${batchMode ? " active" : ""}`}
            onClick={toggleBatchMode}
          >
            {batchMode ? "退出批量" : "批量操作"}
          </button>
          {batchMode && (
            <>
              <span className="admin-batch-count">已选 {selectedIds.size} 个</span>
              <button type="button" className="admin-batch-link" onClick={selectAllVisible}>全选</button>
              <button type="button" className="admin-batch-link" onClick={clearSelection}>清除</button>
              <button
                type="button"
                className="admin-batch-action invalid"
                disabled={batchBusy || selectedIds.size === 0}
                onClick={() => setBatchConfirm("invalid")}
              >
                <AlertTriangle size={12} />标记无效
              </button>
              <button
                type="button"
                className="admin-batch-action delete"
                disabled={batchBusy || selectedIds.size === 0}
                onClick={() => setBatchConfirm("delete")}
              >
                <Trash2 size={12} />删除
              </button>
            </>
          )}
        </div>
        {batchResult && (
          <div className={`admin-alert ${batchResult.type}`} style={{ marginBottom: 10 }}>{batchResult.message}</div>
        )}
        {batchConfirm && (
          <div className="admin-batch-confirm">
            <div className="admin-batch-confirm-text">
              <AlertTriangle size={14} />
              确认对选中的 <b>{selectedIds.size}</b> 个订单执行
              <b>{batchConfirm === "delete" ? "删除" : "标记无效"}</b> 操作?
              {batchConfirm === "delete" && " 删除不可恢复。"}
            </div>
            <div className="admin-batch-confirm-actions">
              <button type="button" onClick={() => setBatchConfirm(null)} disabled={batchBusy}>取消</button>
              <button
                type="button"
                className={batchConfirm === "delete" ? "danger" : "warn"}
                disabled={batchBusy}
                onClick={() => executeBatch(batchConfirm)}
              >
                {batchBusy ? <><LoaderCircle size={12} className="spin-icon" />处理中</> : `确认${batchConfirm === "delete" ? "删除" : "标记"}`}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="admin-loading-inline"><LoaderCircle size={20} className="spin-icon" />加载中</div>
        ) : orders.length === 0 ? (
          <div className="admin-empty"><Inbox size={36} /><p>暂无订单</p></div>
        ) : (
          <div className="admin-orders">
            {orders.map((o) => {
              const isSelected = selectedIds.has(o.orderId);
              return (
                <div
                  key={o.orderId}
                  className={`admin-order-card status-${o.status}${batchMode ? " batch-mode" : ""}${isSelected ? " selected" : ""}`}
                  onClick={() => batchMode ? toggleSelect(o.orderId) : openOrder(o)}
                  role="button"
                  tabIndex={0}
                >
                  {batchMode && (
                    <span className={`admin-order-checkbox${isSelected ? " checked" : ""}`} aria-hidden="true">
                      {isSelected && <CheckCircle2 size={13} />}
                    </span>
                  )}
                  <div className="admin-order-content">
                    <div className="admin-order-top">
                      <span className="admin-order-id">{o.orderId}</span>
                      <span className={`admin-order-status status-${o.status}`}>
                        {o.status === "completed" ? <CheckCircle2 size={11} /> : o.status === "invalid" ? <AlertTriangle size={11} /> : <Clock size={11} />}
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
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </>
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
                  {activeOrder.status === "completed" ? <CheckCircle2 size={12} /> : activeOrder.status === "invalid" ? <AlertTriangle size={12} /> : <Clock size={12} />}
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
                  disabled={saving || deleting}
                >
                  <option value="received">订单已收到</option>
                  <option value="completed">订单已完成(发开通邮件)</option>
                  <option value="invalid">无效·未收到付款</option>
                </select>
                <button
                  type="button"
                  className="admin-save-btn"
                  onClick={saveOrder}
                  disabled={saving || deleting}
                >
                  {saving ? <><LoaderCircle size={14} className="spin-icon" />保存中</> : "保存修改"}
                </button>
              </div>

              {/* Danger zone - delete order */}
              <div className="admin-danger-zone">
                {!confirmDelete ? (
                  <button
                    type="button"
                    className="admin-danger-btn"
                    onClick={() => setConfirmDelete(true)}
                    disabled={saving || deleting}
                  >
                    <Trash2 size={13} />删除订单
                  </button>
                ) : (
                  <div className="admin-danger-confirm">
                    <div className="admin-danger-text">
                      <AlertTriangle size={14} />
                      确认删除该订单?此操作不可恢复。
                    </div>
                    <div className="admin-danger-actions">
                      <button type="button" className="admin-danger-cancel" onClick={() => setConfirmDelete(false)} disabled={deleting}>取消</button>
                      <button type="button" className="admin-danger-confirm-btn" onClick={deleteOrder} disabled={deleting}>
                        {deleting ? <><LoaderCircle size={13} className="spin-icon" />删除中</> : "确认删除"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
