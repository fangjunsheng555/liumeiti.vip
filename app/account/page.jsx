"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Clock, Copy,
  LoaderCircle, LogOut, Mail, ShoppingBag, X,
  AlertTriangle, Wallet, TrendingDown, TrendingUp,
  User, Edit3, Check,
  Gift, Send, CreditCard,
} from "lucide-react";

const STATUS_LABEL = { received: "订单已收到", completed: "订单已完成", invalid: "订单无效·未收到付款" };

function copy(text) {
  if (typeof window === "undefined") return;
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).catch(() => {});
}

export default function AccountPage() {
  const [state, setState] = useState({ loading: true, email: null, username: "", orders: [], balance: 0, txs: [], coupons: [], withdrawals: [] });
  const [activeOrder, setActiveOrder] = useState(null);
  const [showTxs, setShowTxs] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [moneyForm, setMoneyForm] = useState({
    transferEmail: "", transferAmount: "",
    redeemCode: "",
    withdrawAmount: "", alipayAccount: "", realName: "",
  });
  const [moneyBusy, setMoneyBusy] = useState("");
  const [moneyStatus, setMoneyStatus] = useState(null);

  async function load() {
    setState((s) => ({ ...s, loading: true }));
    try {
      const [meRes, balRes] = await Promise.all([
        fetch("/api/auth/me", { credentials: "same-origin" }),
        fetch("/api/auth/balance", { credentials: "same-origin" }),
      ]);
      if (meRes.status === 401) {
        window.location.href = "/?auth=login";
        return;
      }
      const me = await meRes.json();
      const bal = balRes.ok ? await balRes.json() : { balance: 0, transactions: [] };
      if (me.ok) {
        setState({
          loading: false,
          email: me.email,
          username: me.username || "",
          orders: me.orders,
          balance: Number(bal.balance || 0),
          txs: bal.transactions || [],
          coupons: bal.coupons || me.coupons || [],
          withdrawals: bal.withdrawals || [],
        });
      }
    } catch (e) {
      setState({ loading: false, email: null, username: "", orders: [], balance: 0, txs: [], coupons: [], withdrawals: [] });
    }
  }

  useEffect(() => { load(); }, []);

  async function logout() {
    await fetch("/api/auth/login", { method: "DELETE" });
    window.location.href = "/";
  }

  function handleCopy(text, key) {
    copy(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(""), 1800);
  }

  function startEditName() {
    setNameDraft(state.username || "");
    setNameError("");
    setEditingName(true);
  }

  async function saveName() {
    if (nameSaving) return;
    setNameSaving(true);
    setNameError("");
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: nameDraft.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setState((s) => ({ ...s, username: data.username }));
        setEditingName(false);
      } else {
        setNameError(data.message || "用户名格式无效");
      }
    } catch (e) {
      setNameError("网络错误");
    } finally {
      setNameSaving(false);
    }
  }

  function updateMoneyField(field, value) {
    setMoneyForm((cur) => ({ ...cur, [field]: value }));
    if (moneyStatus?.type === "error") setMoneyStatus(null);
  }

  async function submitMoneyAction(action, endpoint, payload, resetFields = []) {
    if (moneyBusy) return;
    setMoneyBusy(action);
    setMoneyStatus(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || data.error || "操作失败");
      setMoneyStatus({ type: "success", message: data.message || "操作成功" });
      setMoneyForm((cur) => {
        const next = { ...cur };
        resetFields.forEach((k) => { next[k] = ""; });
        return next;
      });
      await load();
    } catch (e) {
      setMoneyStatus({ type: "error", message: e.message || "操作失败,请稍后再试" });
    } finally {
      setMoneyBusy("");
    }
  }

  if (state.loading) {
    return <div className="account-loading"><LoaderCircle size={28} className="spin-icon" /></div>;
  }

  return (
    <div className="account-page">
      <header className="account-header">
        <Link href="/" className="account-back">
          <ArrowLeft size={15} />
          <img src="/logo.png" alt="冒央会社" className="account-logo" />
        </Link>
        <button type="button" className="account-logout" onClick={logout}>
          <LogOut size={13} />退出
        </button>
      </header>

      <main className="account-main">
        <section className="account-info-card">
          <div className="account-avatar">{(state.username || state.email || "?")[0].toUpperCase()}</div>
          <div className="account-info-text">
            {editingName ? (
              <div className="account-name-edit">
                <input
                  type="text"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="2-20 位 中/英/数字/_"
                  maxLength={20}
                  autoFocus
                />
                <button type="button" onClick={saveName} disabled={nameSaving} className="account-name-save">
                  {nameSaving ? <LoaderCircle size={12} className="spin-icon" /> : <Check size={12} />}
                </button>
                <button type="button" onClick={() => setEditingName(false)} disabled={nameSaving} className="account-name-cancel"><X size={12} /></button>
              </div>
            ) : (
              <div className="account-username">
                <User size={12} />
                <strong>{state.username || "未设置"}</strong>
                <button type="button" className="account-name-edit-btn" onClick={startEditName} aria-label="修改用户名"><Edit3 size={11} /></button>
              </div>
            )}
            {nameError && <div className="account-name-error">{nameError}</div>}
            <div className="account-info-email">
              <Mail size={11} />
              <span>{state.email}</span>
            </div>
          </div>
        </section>

        <section className="account-balance-card">
          <div className="account-balance-row">
            <div className="account-balance-label">
              <Wallet size={14} />
              账户余额
            </div>
            <div className="account-balance-value">¥{state.balance.toFixed(2)}</div>
          </div>
          <button
            type="button"
            className="account-balance-toggle"
            onClick={() => setShowTxs((v) => !v)}
          >
            {showTxs ? "收起" : "查看"}余额明细 · {state.txs.length} 笔
          </button>
          {showTxs && (
            <div className="account-tx-list">
              {state.txs.length === 0 ? (
                <div className="account-tx-empty">暂无余额变动记录</div>
              ) : (
                state.txs.map((tx) => (
                  <div key={tx.id} className={`account-tx-item${tx.amount > 0 ? " positive" : " negative"}`}>
                    <div className="account-tx-icon">
                      {tx.amount > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                    </div>
                    <div className="account-tx-info">
                      <strong>{tx.reason}</strong>
                      <small>{tx.createdAtBeijing}{tx.statusLabel ? ` · ${tx.statusLabel}` : ""}</small>
                    </div>
                    <div className="account-tx-amount">
                      {tx.amount > 0 ? "+" : ""}¥{Math.abs(tx.amount).toFixed(2)}
                    </div>
                  </div>
                ))
              )}
              <div className="account-tx-note">
                <AlertTriangle size={11} />
                余额仅用于网站会员服务下单时结算,如需充值请联系客服
              </div>
            </div>
          )}
        </section>

        <section className="account-money-tools">
          {moneyStatus && <div className={`account-tool-alert ${moneyStatus.type}`}>{moneyStatus.message}</div>}
          <div className="account-coupon-strip">
            <Gift size={14} />
            <div>
              <strong>付款自动抵扣</strong>
              <span>
                {state.coupons.find((c) => c.status === "active")
                  ? `可用优惠券 ¥${Number(state.coupons.find((c) => c.status === "active").amount || 0).toFixed(2)}`
                  : "暂无可用优惠券"}
              </span>
            </div>
          </div>

          <form
            className="account-tool-card"
            onSubmit={(e) => {
              e.preventDefault();
              submitMoneyAction("transfer", "/api/auth/transfer", {
                email: moneyForm.transferEmail,
                amount: moneyForm.transferAmount,
              }, ["transferEmail", "transferAmount"]);
            }}
          >
            <div className="account-tool-head"><Send size={14} />邮箱转账</div>
            <label className="account-tool-field">
              <span>收款邮箱</span>
              <input value={moneyForm.transferEmail} onChange={(e) => updateMoneyField("transferEmail", e.target.value)} placeholder="对方注册邮箱" inputMode="email" required />
            </label>
            <label className="account-tool-field">
              <span>转账金额</span>
              <input value={moneyForm.transferAmount} onChange={(e) => updateMoneyField("transferAmount", e.target.value)} placeholder="0.00" inputMode="decimal" required />
            </label>
            <button type="submit" disabled={moneyBusy === "transfer"}>{moneyBusy === "transfer" ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}确认转账</button>
          </form>

          <form
            className="account-tool-card"
            onSubmit={(e) => {
              e.preventDefault();
              submitMoneyAction("redeem", "/api/auth/redeem", {
                code: moneyForm.redeemCode,
              }, ["redeemCode"]);
            }}
          >
            <div className="account-tool-head"><Gift size={14} />余额兑换码</div>
            <label className="account-tool-field full">
              <span>兑换码</span>
              <input value={moneyForm.redeemCode} onChange={(e) => updateMoneyField("redeemCode", e.target.value.toUpperCase())} placeholder="输入工作人员发放的兑换码" autoComplete="off" required />
            </label>
            <button type="submit" disabled={moneyBusy === "redeem"}>{moneyBusy === "redeem" ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}立即兑换</button>
          </form>

          <form
            className="account-tool-card withdraw"
            onSubmit={(e) => {
              e.preventDefault();
              submitMoneyAction("withdraw", "/api/auth/withdraw", {
                amount: moneyForm.withdrawAmount,
                alipayAccount: moneyForm.alipayAccount,
                realName: moneyForm.realName,
              }, ["withdrawAmount", "alipayAccount", "realName"]);
            }}
          >
            <div className="account-tool-head"><CreditCard size={14} />余额提现</div>
            <label className="account-tool-field">
              <span>提现金额</span>
              <input value={moneyForm.withdrawAmount} onChange={(e) => updateMoneyField("withdrawAmount", e.target.value)} placeholder="0.00" inputMode="decimal" required />
            </label>
            <label className="account-tool-field">
              <span>姓名</span>
              <input value={moneyForm.realName} onChange={(e) => updateMoneyField("realName", e.target.value)} placeholder="支付宝实名" autoComplete="name" required />
            </label>
            <label className="account-tool-field full">
              <span>支付宝账号</span>
              <input value={moneyForm.alipayAccount} onChange={(e) => updateMoneyField("alipayAccount", e.target.value)} placeholder="手机号 / 邮箱 / 支付宝账号" required />
            </label>
            <button type="submit" disabled={moneyBusy === "withdraw"}>{moneyBusy === "withdraw" ? <LoaderCircle size={13} className="spin-icon" /> : <ArrowRight size={13} />}提交待审核</button>
          </form>
        </section>

        <section className="account-orders">
          <div className="account-orders-head">
            <div>
              <div className="section-kicker">My Orders</div>
              <h2>我的订单</h2>
            </div>
            <span className="account-orders-count">{state.orders.length} 笔</span>
          </div>

          {state.orders.length === 0 ? (
            <div className="account-empty">
              <ShoppingBag size={36} />
              <p>暂无订单</p>
              <Link href="/#products" className="account-empty-cta">前往选购</Link>
            </div>
          ) : (
            <div className="account-orders-list">
              {state.orders.map((o) => (
                <button
                  key={o.orderId}
                  type="button"
                  className={`account-order-card status-${o.status}`}
                  onClick={() => setActiveOrder(o)}
                >
                  <div className="account-order-top">
                    <span className="account-order-id">{o.orderId}</span>
                    <span className={`account-order-status status-${o.status}`}>
                      {o.status === "completed" ? <CheckCircle2 size={11} /> : o.status === "invalid" ? <AlertTriangle size={11} /> : <Clock size={11} />}
                      {STATUS_LABEL[o.status]}
                    </span>
                  </div>
                  <div className="account-order-mid">
                    <span>{o.serviceLabel}</span>
                    {o.itemCount > 1 && <em>{o.itemCount} 件</em>}
                  </div>
                  <div className="account-order-bot">
                    <span>{o.paidCurrency === "CODE" ? "兑换码" : o.paidCurrency === "USDT" ? `${o.paidAmount} USDT` : `¥${o.paidAmount}`}</span>
                    <small>{o.createdAtBeijing?.split(" ")[0] || ""}</small>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>

      {activeOrder && (
        <div className="account-modal-mask" onClick={() => setActiveOrder(null)}>
          <div className="account-modal" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-head">
              <div>
                <div className="account-modal-id">{activeOrder.orderId}</div>
                <div className={`account-modal-status status-${activeOrder.status}`}>
                  {activeOrder.status === "completed" ? <CheckCircle2 size={12} /> : activeOrder.status === "invalid" ? <AlertTriangle size={12} /> : <Clock size={12} />}
                  {STATUS_LABEL[activeOrder.status]}
                </div>
              </div>
              <button type="button" className="account-modal-close" onClick={() => setActiveOrder(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="account-modal-body">
              <div className="account-modal-amount">
                <span>实付金额</span>
                <b>{activeOrder.paidCurrency === "CODE" ? "服务兑换码" : activeOrder.paidCurrency === "USDT" ? `${activeOrder.paidAmount} USDT` : `¥${activeOrder.paidAmount}`}</b>
                <em>{activeOrder.paymentMethod === "redeem" ? "兑换码" : activeOrder.paymentMethod === "usdt" ? "USDT" : "支付宝"}</em>
              </div>

              <div className="account-modal-items-label">商品明细 · {activeOrder.itemCount} 件</div>
              <div className="account-modal-items">
                {activeOrder.items.map((it, idx) => (
                  <div key={idx} className="account-modal-item">
                    <div className="account-modal-item-head">
                      <strong>{it.label}</strong>
                      <span>{it.cycle} · ¥{it.amount}</span>
                    </div>
                    {(it.account || it.password) && (
                      <div className="account-modal-creds">
                        {it.account && (
                          <div>
                            <span>{it.service === "rocket" ? "用户名" : "账号"}</span>
                            <code>{it.account}</code>
                            <button type="button" onClick={() => handleCopy(it.account, `acc-${idx}`)}>
                              {copiedKey === `acc-${idx}` ? "已复制" : <Copy size={11} />}
                            </button>
                          </div>
                        )}
                        {it.password && (
                          <div>
                            <span>密码</span>
                            <code>{it.password}</code>
                            <button type="button" onClick={() => handleCopy(it.password, `pwd-${idx}`)}>
                              {copiedKey === `pwd-${idx}` ? "已复制" : <Copy size={11} />}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {it.subscriptionLinks && (
                      <div className="account-modal-subs">
                        <button type="button" onClick={() => handleCopy(it.subscriptionLinks.shadowrocket, `sr-${idx}`)}>
                          <div>
                            <strong>Shadowrocket 订阅</strong>
                            <small>{it.subscriptionLinks.shadowrocket}</small>
                          </div>
                          <em>{copiedKey === `sr-${idx}` ? "已复制" : "复制"}</em>
                        </button>
                        <button type="button" onClick={() => handleCopy(it.subscriptionLinks.clash, `cl-${idx}`)}>
                          <div>
                            <strong>Clash 订阅</strong>
                            <small>{it.subscriptionLinks.clash}</small>
                          </div>
                          <em>{copiedKey === `cl-${idx}` ? "已复制" : "复制"}</em>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {activeOrder.staffNotes && (
                <div className="account-modal-staff-notes">
                  <div className="account-modal-staff-notes-label">客服备注</div>
                  <div>{activeOrder.staffNotes}</div>
                </div>
              )}

              <div className="account-modal-meta">
                <div><span>下单时间</span><b>{activeOrder.createdAtBeijing}</b></div>
                {activeOrder.completedAtBeijing && (
                  <div><span>完成时间</span><b>{activeOrder.completedAtBeijing}</b></div>
                )}
                <div><span>联系方式</span><b>{activeOrder.contact}</b></div>
                {activeOrder.remark && (
                  <div><span>下单备注</span><b>{activeOrder.remark}</b></div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
