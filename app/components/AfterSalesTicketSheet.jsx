"use client";

import {
  AlertCircle,
  CheckCircle2,
  Headphones,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Send,
  X,
} from "lucide-react";

export default function AfterSalesTicketSheet({
  order,
  form,
  busy,
  status,
  onClose,
  onSubmit,
  onFieldChange,
  onItemChange,
  L,
}) {
  if (!order || !form) return null;
  const items = Array.isArray(form.items) ? form.items : [];
  const contactRequired = items.some((item) => item.service === "spotify" || item.service === "proxy-pay");
  const submitted = status?.type === "success";

  return (
    <div className="after-sales-mask" onClick={() => !busy && onClose()}>
      <section className="after-sales-sheet" role="dialog" aria-modal="true" aria-labelledby="after-sales-title" onClick={(event) => event.stopPropagation()}>
        <header className="after-sales-head">
          <div>
            <span className="after-sales-kicker"><Headphones size={14} />{L("订单售后", "Order after-sales")}</span>
            <h2 id="after-sales-title">{submitted ? L("售后工单已提交", "Ticket submitted") : L("申请售后", "Request after-sales")}</h2>
          </div>
          <button type="button" className="after-sales-close" onClick={onClose} disabled={busy} aria-label={L("关闭", "Close")}><X size={19} /></button>
        </header>

        {submitted ? (
          <div className="after-sales-success">
            <span className="after-sales-success-icon"><CheckCircle2 size={30} /></span>
            <h3>{L("您的售后工单已收到", "We received your after-sales ticket")}</h3>
            <p>{L("工作人员会尽快核查并处理，完成后将发送邮件至下单邮箱。", "Our team will review it as soon as possible and email the order address when it is complete.")}</p>
            <div className="after-sales-success-meta">
              <span>{L("工单编号", "Ticket")}</span>
              <code>{status.ticketId}</code>
              <span>{L("关联订单", "Order")}</span>
              <code>{order.orderId}</code>
            </div>
            {status.emailWarning && <div className="after-sales-email-warning"><AlertCircle size={15} />{L("工单已保存，确认邮件暂未送达，不影响后续处理。", "Your ticket is saved. The confirmation email was delayed, but processing is unaffected.")}</div>}
            <button type="button" className="after-sales-done-btn" onClick={onClose}>{L("返回订单详情", "Back to order details")}</button>
          </div>
        ) : (
          <form className="after-sales-form" onSubmit={onSubmit}>
            <div className="after-sales-order-context">
              <div><span>{L("关联订单", "Order")}</span><code>{order.orderId}</code></div>
              <strong>{order.serviceLabel || L("订单服务", "Order service")}</strong>
            </div>

            <section className="after-sales-form-section primary-section">
              <div className="after-sales-section-title">
                <span>01</span>
                <div><strong>{L("说明需要处理的问题", "Describe the issue")}</strong><small>{L("请写明异常现象、发生时间及希望协助的事项", "Include what happened, when it started and the help you need")}</small></div>
              </div>
              <label className="after-sales-field">
                <span>{L("问题说明", "Issue details")} <em>*</em></span>
                <textarea
                  value={form.issue}
                  onChange={(event) => onFieldChange("issue", event.target.value)}
                  placeholder={L("例如：账号无法登录，页面提示密码错误，今天首次出现", "Example: I cannot sign in and the page reports an incorrect password; this started today")}
                  maxLength={2000}
                  required
                />
                <small>{form.issue.length}/2000</small>
              </label>
            </section>

            <section className="after-sales-form-section">
              <div className="after-sales-section-title">
                <span>02</span>
                <div><strong>{L("核对服务资料", "Review service details")}</strong><small>{L("已从原订单自动填充，可按当前情况修改", "Pre-filled from the order and editable for the current situation")}</small></div>
              </div>
              <label className="after-sales-field after-sales-email-field">
                <span>{L("下单邮箱", "Order email")}</span>
                <div className="after-sales-locked-input"><Mail size={15} /><input type="email" value={form.email} readOnly /><LockKeyhole size={14} /></div>
                <small>{L("处理进度与结果将发送至已验证的下单邮箱", "Updates and results go to the verified order email")}</small>
              </label>

              {items.map((item, index) => {
                const needsCredentials = item.service === "spotify";
                const isProxy = item.service === "proxy-pay";
                if (!needsCredentials && !isProxy) return null;
                return (
                  <div className="after-sales-item-config" key={`${item.service}-${index}`}>
                    <div className="after-sales-item-title"><span>{index + 1}</span><strong>{item.label}</strong></div>
                    {needsCredentials && (
                      <div className="after-sales-field-grid">
                        <label className="after-sales-field">
                          <span>{L("开通账号 / 邮箱", "Account / email")} <em>*</em></span>
                          <input value={item.account} onChange={(event) => onItemChange(index, "account", event.target.value)} maxLength={80} required />
                        </label>
                        <label className="after-sales-field">
                          <span>{L("账号密码", "Account password")} <em>*</em></span>
                          <input type="password" value={item.password} onChange={(event) => onItemChange(index, "password", event.target.value)} maxLength={120} autoComplete="current-password" required />
                        </label>
                      </div>
                    )}
                    {isProxy && (
                      <>
                        <label className="after-sales-field">
                          <span>{L("网站链接 / 平台", "Website / platform")} <em>*</em></span>
                          <div className="after-sales-icon-input"><Link2 size={15} /><input type="url" value={item.platformUrl} onChange={(event) => onItemChange(index, "platformUrl", event.target.value)} maxLength={1000} required /></div>
                        </label>
                        <label className="after-sales-field">
                          <span>{L("商品标价", "Listed price")} <em>*</em></span>
                          <input value={item.productPrice} onChange={(event) => onItemChange(index, "productPrice", event.target.value)} maxLength={120} required />
                        </label>
                      </>
                    )}
                  </div>
                );
              })}

              <div className="after-sales-field-grid">
                <label className="after-sales-field">
                  <span>{L("联系方式", "Contact")} {contactRequired ? <em>*</em> : <i>{L("选填", "Optional")}</i>}</span>
                  <input
                    value={form.contact}
                    onChange={(event) => onFieldChange("contact", event.target.value)}
                    placeholder={L("QQ / 微信 / WhatsApp / Telegram", "QQ / WeChat / WhatsApp / Telegram")}
                    maxLength={200}
                    required={contactRequired}
                  />
                </label>
                <label className="after-sales-field">
                  <span>{L("原订单备注", "Order note")} <i>{L("选填", "Optional")}</i></span>
                  <textarea value={form.remark} onChange={(event) => onFieldChange("remark", event.target.value)} maxLength={1500} placeholder={L("可补充与本次售后有关的信息", "Add anything relevant to this request")} />
                </label>
              </div>
            </section>

            {status?.type === "error" && <div className="after-sales-form-error"><AlertCircle size={15} />{status.message}</div>}
            <div className="after-sales-submit-row">
              <div><LockKeyhole size={14} /><span>{L("资料仅用于核查该订单及处理售后", "Details are used only to verify this order and handle the request")}</span></div>
              <button type="submit" disabled={busy}>
                {busy ? <LoaderCircle size={16} className="spin-icon" /> : <Send size={16} />}
                {busy ? L("正在提交", "Submitting") : L("提交售后工单", "Submit ticket")}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
