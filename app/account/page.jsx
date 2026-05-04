"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, ArrowRight, CheckCircle2, Clock, Copy,
  LoaderCircle, LogOut, Mail, ShoppingBag, X,
} from "lucide-react";

const STATUS_LABEL = { received: "订单已收到", completed: "订单已完成" };

function copy(text) {
  if (typeof window === "undefined") return;
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).catch(() => {});
}

export default function AccountPage() {
  const [state, setState] = useState({ loading: true, email: null, orders: [] });
  const [activeOrder, setActiveOrder] = useState(null);
  const [copiedKey, setCopiedKey] = useState("");

  async function load() {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (res.status === 401) {
        window.location.href = "/?auth=login";
        return;
      }
      const data = await res.json();
      if (data.ok) {
        setState({ loading: false, email: data.email, orders: data.orders });
      }
    } catch (e) {
      setState({ loading: false, email: null, orders: [] });
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
          <div className="account-avatar">{(state.email || "?")[0].toUpperCase()}</div>
          <div>
            <div className="account-info-label">已登录账号</div>
            <div className="account-info-email">
              <Mail size={13} />
              {state.email}
            </div>
          </div>
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
                      {o.status === "completed" ? <CheckCircle2 size={11} /> : <Clock size={11} />}
                      {STATUS_LABEL[o.status]}
                    </span>
                  </div>
                  <div className="account-order-mid">
                    <span>{o.serviceLabel}</span>
                    {o.itemCount > 1 && <em>{o.itemCount} 件</em>}
                  </div>
                  <div className="account-order-bot">
                    <span>{o.paidCurrency === "USDT" ? `${o.paidAmount} USDT` : `¥${o.paidAmount}`}</span>
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
                  {activeOrder.status === "completed" ? <CheckCircle2 size={12} /> : <Clock size={12} />}
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
                <b>{activeOrder.paidCurrency === "USDT" ? `${activeOrder.paidAmount} USDT` : `¥${activeOrder.paidAmount}`}</b>
                <em>{activeOrder.paymentMethod === "usdt" ? "USDT" : "支付宝"}</em>
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
