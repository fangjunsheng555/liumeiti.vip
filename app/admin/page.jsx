"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { PRODUCTS, getProductPlan, getProductPlanOptions, hasProductPlans, useSiteSettings, getSiteSettings } from "../lib/store";
import { getSpotifyPasswordAttention } from "../lib/order-attention";
import VisitorsPanel from "./VisitorsPanel";
import AbandonedPanel from "./AbandonedPanel";
import InsightsPanel from "./InsightsPanel";
import { OverviewTrendCard } from "./AnalyticsCharts";
import UserActivity from "./UserActivity";
import AnnouncePanel from "./AnnouncePanel";
import AnnouncePostsPanel from "./AnnouncePostsPanel";
import AIQuotaPanel from "./AIQuotaPanel";
import CatalogPanel from "./CatalogPanel";
import SettingsPanel from "./SettingsPanel";
import SecurityPanel from "./SecurityPanel";
import AfterSalesPanel from "./AfterSalesPanel";
import MailDeliveryPanel from "./MailDeliveryPanel";
import SystemHealthPanel from "./SystemHealthPanel";
import {
  ArrowLeft, ChevronDown, Copy, Eye, EyeOff, ExternalLink,
  LoaderCircle, LogOut, Search, ShieldCheck,
  CheckCircle2, Clock, Inbox, X, AlertTriangle, Trash2,
  Gift, CreditCard, Plus, UserPlus, Mail, BellRing, BarChart3, Download, FileText,
  LayoutDashboard, ClipboardList, ShoppingCart, Users, Wallet, Coins,
  Megaphone, Footprints, Menu, Newspaper, Gauge, Package, SlidersHorizontal,
  LifeBuoy, MailCheck, Activity,
} from "lucide-react";

const STATUS_LABEL = {
  awaiting_quote: "等待报价",
  pending_payment: "等待付款",
  quote_expired: "报价已失效",
  received: "订单已收到",
  completed: "订单已完成",
  invalid: "无效·未收到付款",
};

const STATUS_ICON_KEY = {
  awaiting_quote: "clock",
  pending_payment: "clock",
  quote_expired: "clock",
  received: "clock",
  completed: "check",
  invalid: "x",
};
const WITHDRAWAL_STATUS = [
  ["pending", "待审核"],
  ["processing", "提现中"],
  ["success", "提现成功"],
  ["failed", "审核失败"],
];
const MARKETING_MAIL_TEMPLATE_ID = "membership_edm_v4";
const MARKETING_MAIL_SUBJECT = "常用会员服务，立即下单开通";
const MARKETING_MAIL_PREVIEW = "Spotify、4K 影音、AI 会员与机场节点，明码标价，付款后开通。";
const MAIL_BATCH_LIMIT = 20;

function copyText(text) {
  if (typeof window === "undefined") return;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

function splitIntoBatches(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function normalizeEmailList(values) {
  return Array.from(new Set((values || [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))));
}

function extractEmailsFromText(value) {
  return String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
}

function referralCommissionTotal(order) {
  return (Array.isArray(order?.referralCommissionEntries) ? order.referralCommissionEntries : [])
    .reduce((sum, entry) => sum + Number(entry?.amount || 0), 0);
}

function referralCommissionReversedTotal(order) {
  return (Array.isArray(order?.referralCommissionReversedEntries) ? order.referralCommissionReversedEntries : [])
    .reduce((sum, entry) => sum + Number(entry?.amount || 0), 0);
}

function referralCommissionLabel(order) {
  if (!order?.referral?.levelOneEmail) return "";
  if (order.referralCommissionSettledAt) return `已结算 ¥${referralCommissionTotal(order).toFixed(2)}`;
  // 曾结算后又被作废 → 冲正回收
  if (order.referralCommissionReversedAt) return `已冲正 ¥${referralCommissionReversedTotal(order).toFixed(2)}`;
  return order.status === "completed" ? "待结算" : "完成后结算";
}

function actionDetailText(item) {
  if (typeof item?.detailText === "string" && item.detailText.trim()) return item.detailText;
  if (typeof item?.detail === "string" && item.detail.trim()) return item.detail;
  const detail = item?.detail;
  if (detail && typeof detail === "object") {
    const labels = {
      username: "账号",
      role: "角色",
      email: "用户",
      amount: "金额",
      balanceBefore: "调整前",
      balanceAfter: "调整后",
      status: "状态",
      from: "原状态",
      to: "新状态",
      type: "类型",
      quantity: "数量",
      total: "总数",
      changed: "变更",
      deletedCount: "删除",
      successCount: "成功",
      failedCount: "失败",
      sentCount: "发送成功",
      orderId: "订单",
      logId: "记录",
      ip: "IP",
      userAgent: "UA",
    };
    const parts = Object.entries(detail)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .slice(0, 8)
      .map(([key, value]) => {
        const text = Array.isArray(value) ? value.slice(0, 5).join(", ") : String(value);
        return `${labels[key] || key}: ${text}${Array.isArray(value) && value.length > 5 ? "..." : ""}`;
      });
    if (parts.length) return parts.join("；");
  }
  return "已记录一次后台操作";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function exportRedeemHistoryPdfLegacy(record) {
  if (typeof window === "undefined" || !record) return;
  const logoUrl = `${window.location.origin}/email-logo.png`;
  const generatedAt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date()).replace(/\//g, "-");
  const voucherNo = `RV-${String(record.code || "").slice(0, 24)}`;
  const inputs = Array.isArray(record.order?.inputs) && record.order.inputs.length
    ? record.order.inputs.map((item) => `
      <tr>
        <td>${escapeHtml(item.label)}</td>
        <td>${escapeHtml(item.value)}</td>
      </tr>
    `).join("")
    : `<tr><td>用户输入</td><td>无额外输入</td></tr>`;
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>兑换记录 ${escapeHtml(record.code)}</title>
      <style>
        @page { size: A4; margin: 0; }
        * { box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
          color: #0f172a;
          margin: 0;
          background: #fff;
        }
        .sheet {
          width: 210mm;
          min-height: 297mm;
          margin: 0 auto;
          padding: 20mm 22mm 17mm;
          background: #fff;
          position: relative;
          overflow: hidden;
        }
        .sheet:before {
          content: "";
          position: absolute;
          inset: 12mm;
          border: 1px solid #b7e7df;
          border-radius: 22px;
          pointer-events: none;
        }
        .watermark {
          position: absolute;
          right: -12mm;
          top: 83mm;
          font-size: 68px;
          font-weight: 900;
          letter-spacing: 0;
          color: rgba(15, 118, 110, 0.045);
          transform: rotate(-90deg);
          transform-origin: center;
          white-space: nowrap;
        }
        .content { position: relative; z-index: 1; }
        .topbar {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 24px;
          padding-bottom: 18px;
          border-bottom: 2px solid #0f766e;
        }
        .brand img {
          width: 206px;
          max-height: 82px;
          height: auto;
          object-fit: contain;
          display: block;
        }
        .brand .name {
          margin-top: 7px;
          color: #0f766e;
          font-size: 12px;
          font-weight: 800;
        }
        .brand .site {
          margin-top: 3px;
          color: #64748b;
          font-size: 10.5px;
          font-weight: 700;
        }
        .doc-meta {
          min-width: 196px;
          text-align: right;
          color: #475569;
          font-size: 11px;
          line-height: 1.8;
        }
        .doc-meta b {
          display: block;
          color: #0f172a;
          font-size: 12px;
          word-break: break-all;
        }
        .hero {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 18px;
          align-items: center;
          padding: 22px 0 18px;
        }
        .eyebrow {
          color: #0f766e;
          font-size: 12px;
          font-weight: 900;
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }
        h1 {
          font-size: 30px;
          margin: 7px 0 8px;
          letter-spacing: 0;
          color: #0f172a;
          line-height: 1.15;
        }
        .hero p {
          margin: 0;
          color: #64748b;
          font-size: 13px;
          line-height: 1.7;
        }
        .stamp {
          width: 86px;
          height: 86px;
          border: 3px solid #0f766e;
          border-radius: 50%;
          display: grid;
          place-items: center;
          color: #0f766e;
          font-size: 17px;
          font-weight: 900;
          transform: rotate(-12deg);
          background: rgba(240, 253, 250, 0.75);
        }
        .code-card {
          border-radius: 20px;
          padding: 18px 20px;
          margin-bottom: 14px;
          background: linear-gradient(135deg, #0f172a 0%, #134e4a 100%);
          color: #fff;
          box-shadow: 0 18px 34px rgba(15, 23, 42, 0.16);
        }
        .code-card span {
          display: block;
          color: #a7f3d0;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        .code-card b {
          display: block;
          margin-top: 9px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 28px;
          letter-spacing: 0.06em;
          word-break: break-all;
        }
        .section-title {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 12px;
          font-size: 14px;
          color: #0f172a;
          font-weight: 900;
        }
        .section-title:before {
          content: "";
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #14b8a6;
        }
        .card {
          border: 1px solid #d6ebe7;
          border-radius: 18px;
          padding: 17px 18px;
          margin-bottom: 16px;
          background: rgba(255, 255, 255, 0.92);
          box-shadow: 0 12px 28px rgba(15, 23, 42, 0.055);
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        .field {
          min-height: 58px;
          padding: 10px 12px;
          border-radius: 13px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
        }
        .field.span-2 { grid-column: 1 / -1; }
        .field span {
          display: block;
          margin-bottom: 5px;
          color: #64748b;
          font-size: 10.5px;
          font-weight: 900;
        }
        .field b {
          display: block;
          color: #102033;
          font-size: 13px;
          line-height: 1.45;
          word-break: break-all;
        }
        .summary {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 16px;
        }
        .summary .field {
          min-height: 66px;
          background: #f0fdfa;
          border-color: #b7e7df;
        }
        table {
          width: 100%;
          border-collapse: separate;
          border-spacing: 0;
          font-size: 13px;
          overflow: hidden;
          border: 1px solid #d8efe9;
          border-radius: 14px;
          background: #fff;
        }
        td {
          border-bottom: 1px solid #e2e8f0;
          padding: 12px 14px;
          vertical-align: top;
          word-break: break-all;
          line-height: 1.6;
        }
        tr:last-child td { border-bottom: 0; }
        td:first-child { width: 150px; color: #64748b; font-weight: 900; background: #f8fafc; }
        td:last-child { white-space: pre-wrap; }
        .foot {
          margin-top: 22px;
          padding-top: 14px;
          border-top: 1px solid #e2e8f0;
          font-size: 11px;
          color: #64748b;
          text-align: center;
        }
        .sheet { padding: 14mm 17mm 12mm; }
        .sheet:before { inset: 8mm; border-radius: 18px; }
        .watermark { top: 76mm; font-size: 54px; }
        .topbar { gap: 16px; padding-bottom: 11px; }
        .brand img { width: 166px; max-height: 60px; }
        .brand .name { margin-top: 5px; font-size: 11px; }
        .brand .site { margin-top: 2px; font-size: 9.5px; }
        .doc-meta { min-width: 160px; font-size: 9.5px; line-height: 1.5; }
        .doc-meta b { font-size: 10.5px; }
        .hero { gap: 12px; padding: 13px 0 11px; }
        .eyebrow { font-size: 10.5px; }
        h1 { font-size: 24px; margin: 4px 0 5px; }
        .hero p { font-size: 11.5px; line-height: 1.45; }
        .stamp { width: 64px; height: 64px; border-width: 2px; font-size: 13.5px; }
        .code-card { border-radius: 16px; padding: 12px 15px; margin-bottom: 9px; box-shadow: 0 8px 18px rgba(15, 23, 42, 0.1); }
        .code-card span { font-size: 9.5px; }
        .code-card b { margin-top: 5px; font-size: 22px; }
        .section-title { gap: 6px; margin-bottom: 7px; font-size: 12.5px; }
        .section-title:before { width: 7px; height: 7px; }
        .card { border-radius: 13px; padding: 11px 12px; margin-bottom: 9px; box-shadow: 0 4px 10px rgba(15, 23, 42, 0.035); }
        .grid { gap: 7px; }
        .field { min-height: 44px; padding: 7px 9px; border-radius: 9px; }
        .field span { margin-bottom: 3px; font-size: 9.5px; }
        .field b { font-size: 11.5px; line-height: 1.28; }
        .summary { gap: 7px; margin-bottom: 9px; }
        .summary .field { min-height: 50px; }
        table { font-size: 11.5px; border-radius: 10px; }
        td { padding: 7px 9px; line-height: 1.42; }
        td:first-child { width: 122px; }
        .voucher-note { margin-top: 7px; font-size: 11.5px; line-height: 1.4; }
        .foot { margin-top: 12px; padding-top: 8px; font-size: 9.5px; }
        @media print {
          body { background: #fff !important; width: 210mm; min-height: 297mm; overflow: hidden; }
          .sheet {
            background: #fff !important;
            box-shadow: none;
            transform: scale(0.7);
            transform-origin: top center;
            margin: 8mm auto 0;
          }
          .watermark { color: rgba(15, 118, 110, 0.035); }
        }
      </style>
    </head>
    <body>
      <main class="sheet">
        <div class="watermark">MAOYANG TAIWAN INC</div>
        <div class="content">
          <header class="topbar">
            <div class="brand">
              <img src="${logoUrl}" alt="Maoyang Taiwan Inc" />
              <div class="name">${getSiteSettings().footer.brand}</div>
              <div class="site">网址:https://www.liumeiti.vip</div>
            </div>
            <div class="doc-meta">
              凭证编号
              <b>${escapeHtml(voucherNo)}</b>
              生成时间
              <b>${escapeHtml(generatedAt)}</b>
            </div>
          </header>

          <section class="hero">
            <div>
              <div class="eyebrow">Redeem Certificate</div>
              <h1>兑换码兑换凭证</h1>
              <p>用于核对兑换码状态、订单信息、兑换时间与用户提交内容</p>
            </div>
            <div class="stamp">已兑换</div>
          </section>

          <section class="code-card">
            <span>Redeem Code</span>
            <b>${escapeHtml(record.code)}</b>
          </section>

          <section class="summary">
            <div class="field">
              <span>兑换类型</span>
              <b>${escapeHtml(record.typeLabel)}</b>
            </div>
            <div class="field">
              <span>兑换内容</span>
              <b>${escapeHtml(record.valueLabel)}</b>
            </div>
            <div class="field">
              <span>对应订单</span>
              <b>${escapeHtml(record.usedOrderId || "无订单")}</b>
            </div>
          </section>

          <section class="card">
            <div class="section-title">兑换信息</div>
            <div class="grid">
              <div class="field">
                <span>兑换用户</span>
                <b>${escapeHtml(record.usedBy || "未记录")}</b>
              </div>
              <div class="field">
                <span>用户 IP</span>
                <b>${escapeHtml(record.usedIp || "未记录")}</b>
              </div>
              <div class="field span-2">
                <span>用户浏览器 UA</span>
                <b>${escapeHtml(record.usedUserAgent || "未记录")}</b>
              </div>
              <div class="field">
                <span>兑换时间</span>
                <b>${escapeHtml(record.usedAtBeijing || record.usedAt || "未记录")}</b>
              </div>
              <div class="field">
                <span>订单完成时间</span>
                <b>${escapeHtml(record.order?.completedAtBeijing || "未完成或无订单")}</b>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="section-title">用户订单输入内容</div>
            <table>${inputs}</table>
          </section>

          <div class="foot">${getSiteSettings().footer.copyright}</div>
        </div>
      </main>
      <script>
        function printWhenReady() {
          var images = Array.prototype.slice.call(document.images || []);
          var pending = images.filter(function (img) { return !img.complete; });
          if (!pending.length) {
            setTimeout(function () { window.print(); }, 350);
            return;
          }
          var left = pending.length;
          pending.forEach(function (img) {
            function done() {
              left -= 1;
              if (left <= 0) setTimeout(function () { window.print(); }, 350);
            }
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
          setTimeout(function () { window.print(); }, 1800);
        }
        window.addEventListener("load", printWhenReady);
      </script>
    </body>
  </html>`;
  const win = window.open("", "_blank", "width=820,height=900");
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
}

function pdfGeneratedAt() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date()).replace(/\//g, "-");
}

function openVoucherPdf({
  docTitle,
  voucherNo,
  eyebrow,
  title,
  description,
  stamp,
  mainLabel,
  mainValue,
  summaryFields = [],
  detailTitle,
  detailFields = [],
  tableTitle,
  tableRows = [],
  note = "",
}) {
  if (typeof window === "undefined") return;
  const logoUrl = `${window.location.origin}/email-logo.png`;
  const generatedAt = pdfGeneratedAt();
  const noteText = String(note || "").trim().slice(0, 180);
  const safeTableRows = tableRows
    .map((item) => ({
      label: pdfText(item?.label, 160),
      value: pdfText(item?.value, 1600),
    }))
    .filter((item) => item.label && item.value);
  const summaryHtml = summaryFields.map((item) => `
    <div class="field">
      <span>${escapeHtml(item.label)}</span>
      <b>${escapeHtml(item.value || "未记录")}</b>
    </div>
  `).join("");
  const detailHtml = detailFields.map((item) => `
    <div class="field${item.wide ? " span-2" : ""}">
      <span>${escapeHtml(item.label)}</span>
      <b>${escapeHtml(item.value || "未记录")}</b>
    </div>
  `).join("");
  const tableHtml = safeTableRows.length
    ? safeTableRows.map((item) => `
      <tr>
        <td>${escapeHtml(item.label)}</td>
        <td>${escapeHtml(item.value)}</td>
      </tr>
    `).join("")
    : `<tr><td>记录内容</td><td>无额外内容</td></tr>`;
  const noteHtml = noteText ? `
    <div class="voucher-note">*凭证备注：${escapeHtml(noteText)}</div>
  ` : "";
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(docTitle || title || "凭证")}</title>
      <style>
        @page { size: A4; margin: 0; }
        * { box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
          color: #0f172a;
          margin: 0;
          background: #fff;
        }
        .sheet {
          width: 210mm;
          min-height: 297mm;
          margin: 0 auto;
          padding: 20mm 22mm 17mm;
          background: #fff;
          position: relative;
          overflow: hidden;
        }
        .sheet:before {
          content: "";
          position: absolute;
          inset: 12mm;
          border: 1px solid #b7e7df;
          border-radius: 22px;
          pointer-events: none;
        }
        .watermark {
          position: absolute;
          right: -12mm;
          top: 83mm;
          font-size: 68px;
          font-weight: 900;
          letter-spacing: 0;
          color: rgba(15, 118, 110, 0.045);
          transform: rotate(-90deg);
          transform-origin: center;
          white-space: nowrap;
        }
        .content { position: relative; z-index: 1; }
        .topbar {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 24px;
          padding-bottom: 18px;
          border-bottom: 2px solid #0f766e;
        }
        .brand img {
          width: 206px;
          max-height: 82px;
          height: auto;
          object-fit: contain;
          display: block;
        }
        .brand .name {
          margin-top: 7px;
          color: #0f766e;
          font-size: 12px;
          font-weight: 800;
        }
        .brand .site {
          margin-top: 3px;
          color: #64748b;
          font-size: 10.5px;
          font-weight: 700;
        }
        .doc-meta {
          min-width: 196px;
          text-align: right;
          color: #475569;
          font-size: 11px;
          line-height: 1.8;
        }
        .doc-meta b {
          display: block;
          color: #0f172a;
          font-size: 12px;
          word-break: break-all;
        }
        .doc-meta .url {
          color: #0f766e;
          font-size: 11px;
        }
        .hero {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 18px;
          align-items: center;
          padding: 22px 0 18px;
        }
        .eyebrow {
          color: #0f766e;
          font-size: 12px;
          font-weight: 900;
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }
        h1 {
          font-size: 30px;
          margin: 7px 0 8px;
          letter-spacing: 0;
          color: #0f172a;
          line-height: 1.15;
        }
        .hero p {
          margin: 0;
          color: #64748b;
          font-size: 13px;
          line-height: 1.7;
        }
        .stamp {
          width: 86px;
          height: 86px;
          border: 3px solid #0f766e;
          border-radius: 50%;
          display: grid;
          place-items: center;
          color: #0f766e;
          font-size: 17px;
          font-weight: 900;
          transform: rotate(-12deg);
          background: rgba(240, 253, 250, 0.75);
        }
        .code-card {
          border-radius: 20px;
          padding: 18px 20px;
          margin-bottom: 14px;
          background: linear-gradient(135deg, #0f172a 0%, #134e4a 100%);
          color: #fff;
          box-shadow: 0 18px 34px rgba(15, 23, 42, 0.16);
        }
        .code-card span {
          display: block;
          color: #a7f3d0;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        .code-card b {
          display: block;
          margin-top: 9px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 28px;
          letter-spacing: 0.06em;
          word-break: break-all;
        }
        .section-title {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 12px;
          font-size: 14px;
          color: #0f172a;
          font-weight: 900;
        }
        .section-title:before {
          content: "";
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #14b8a6;
        }
        .card {
          border: 1px solid #d6ebe7;
          border-radius: 18px;
          padding: 17px 18px;
          margin-bottom: 16px;
          background: rgba(255, 255, 255, 0.92);
          box-shadow: 0 12px 28px rgba(15, 23, 42, 0.055);
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        .field {
          min-height: 58px;
          padding: 10px 12px;
          border-radius: 13px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
        }
        .field.span-2 { grid-column: 1 / -1; }
        .field span {
          display: block;
          margin-bottom: 5px;
          color: #64748b;
          font-size: 10.5px;
          font-weight: 900;
        }
        .field b {
          display: block;
          color: #102033;
          font-size: 13px;
          line-height: 1.45;
          word-break: break-all;
        }
        .summary {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 16px;
        }
        .summary .field {
          min-height: 66px;
          background: #f0fdfa;
          border-color: #b7e7df;
        }
        table {
          width: 100%;
          border-collapse: separate;
          border-spacing: 0;
          font-size: 13px;
          overflow: hidden;
          border: 1px solid #d8efe9;
          border-radius: 14px;
          background: #fff;
        }
        td {
          border-bottom: 1px solid #e2e8f0;
          padding: 12px 14px;
          vertical-align: top;
          word-break: break-all;
          line-height: 1.6;
        }
        tr:last-child td { border-bottom: 0; }
        td:first-child { width: 150px; color: #64748b; font-weight: 900; background: #f8fafc; }
        td:last-child { white-space: pre-wrap; }
        .voucher-note {
          margin-top: 11px;
          color: #b91c1c;
          font-size: 13px;
          line-height: 1.65;
          font-weight: 900;
          word-break: break-word;
        }
        .foot {
          margin-top: 22px;
          padding-top: 14px;
          border-top: 1px solid #e2e8f0;
          font-size: 11px;
          color: #64748b;
          text-align: center;
        }
        .sheet { padding: 14mm 17mm 12mm; }
        .sheet:before { inset: 8mm; border-radius: 18px; }
        .watermark { top: 76mm; font-size: 54px; }
        .topbar { gap: 16px; padding-bottom: 11px; }
        .brand img { width: 166px; max-height: 60px; }
        .brand .name { margin-top: 5px; font-size: 11px; }
        .brand .site { margin-top: 2px; font-size: 9.5px; }
        .doc-meta { min-width: 160px; font-size: 9.5px; line-height: 1.5; }
        .doc-meta b { font-size: 10.5px; }
        .hero { gap: 12px; padding: 13px 0 11px; }
        .eyebrow { font-size: 10.5px; }
        h1 { font-size: 24px; margin: 4px 0 5px; }
        .hero p { font-size: 11.5px; line-height: 1.45; }
        .stamp { width: 64px; height: 64px; border-width: 2px; font-size: 13.5px; }
        .code-card { border-radius: 16px; padding: 12px 15px; margin-bottom: 9px; box-shadow: 0 8px 18px rgba(15, 23, 42, 0.1); }
        .code-card span { font-size: 9.5px; }
        .code-card b { margin-top: 5px; font-size: 22px; }
        .section-title { gap: 6px; margin-bottom: 7px; font-size: 12.5px; }
        .section-title:before { width: 7px; height: 7px; }
        .card { border-radius: 13px; padding: 11px 12px; margin-bottom: 9px; box-shadow: 0 4px 10px rgba(15, 23, 42, 0.035); }
        .grid { gap: 7px; }
        .field { min-height: 44px; padding: 7px 9px; border-radius: 9px; }
        .field span { margin-bottom: 3px; font-size: 9.5px; }
        .field b { font-size: 11.5px; line-height: 1.28; }
        .summary { gap: 7px; margin-bottom: 9px; }
        .summary .field { min-height: 50px; }
        table { font-size: 11.5px; border-radius: 10px; }
        td { padding: 7px 9px; line-height: 1.42; }
        td:first-child { width: 122px; }
        .voucher-note { margin-top: 7px; font-size: 11.5px; line-height: 1.4; }
        .foot { margin-top: 12px; padding-top: 8px; font-size: 9.5px; }
        @media print {
          body { background: #fff !important; width: 210mm; min-height: 297mm; overflow: hidden; }
          .sheet {
            background: #fff !important;
            box-shadow: none;
            transform: scale(0.7);
            transform-origin: top center;
            margin: 8mm auto 0;
          }
          .watermark { color: rgba(15, 118, 110, 0.035); }
        }
      </style>
    </head>
    <body>
      <main class="sheet">
        <div class="watermark">MAOYANG TAIWAN INC</div>
        <div class="content">
          <header class="topbar">
            <div class="brand">
              <img src="${logoUrl}" alt="Maoyang Taiwan Inc" />
              <div class="name">${getSiteSettings().footer.brand}</div>
              <div class="site">网址:https://www.liumeiti.vip</div>
            </div>
            <div class="doc-meta">
              凭证编号
              <b>${escapeHtml(voucherNo)}</b>
              生成时间
              <b>${escapeHtml(generatedAt)}</b>
            </div>
          </header>

          <section class="hero">
            <div>
              <div class="eyebrow">${escapeHtml(eyebrow)}</div>
              <h1>${escapeHtml(title)}</h1>
              <p>${escapeHtml(description)}</p>
            </div>
            <div class="stamp">${escapeHtml(stamp)}</div>
          </section>

          <section class="code-card">
            <span>${escapeHtml(mainLabel)}</span>
            <b>${escapeHtml(mainValue)}</b>
          </section>

          <section class="summary">${summaryHtml}</section>

          <section class="card">
            <div class="section-title">${escapeHtml(detailTitle)}</div>
            <div class="grid">${detailHtml}</div>
          </section>

          <section class="card">
            <div class="section-title">${escapeHtml(tableTitle)}</div>
            <table>${tableHtml}</table>
            ${noteHtml}
          </section>

          <div class="foot">${getSiteSettings().footer.copyright}</div>
        </div>
      </main>
      <script>
        function printWhenReady() {
          var images = Array.prototype.slice.call(document.images || []);
          var pending = images.filter(function (img) { return !img.complete; });
          if (!pending.length) {
            setTimeout(function () { window.print(); }, 350);
            return;
          }
          var left = pending.length;
          pending.forEach(function (img) {
            function done() {
              left -= 1;
              if (left <= 0) setTimeout(function () { window.print(); }, 350);
            }
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
          setTimeout(function () { window.print(); }, 1800);
        }
        window.addEventListener("load", printWhenReady);
      </script>
    </body>
  </html>`;
  const win = window.open("", "_blank", "width=820,height=900");
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
}

function exportRedeemHistoryPdf(record, note = "") {
  if (!record) return;
  const inputRows = Array.isArray(record.order?.inputs) && record.order.inputs.length
    ? record.order.inputs
    : [{ label: "用户输入", value: "无额外输入" }];
  openVoucherPdf({
    docTitle: `兑换记录 ${record.code || ""}`,
    voucherNo: `RV-${String(record.code || "").slice(0, 24)}`,
    eyebrow: "Redeem Certificate",
    title: "兑换码兑换凭证",
    description: "用于核对兑换码状态、订单信息、兑换时间与用户提交内容",
    stamp: "已兑换",
    mainLabel: "Redeem Code",
    mainValue: record.code || "",
    summaryFields: [
      { label: "兑换类型", value: record.typeLabel },
      { label: "兑换内容", value: record.valueLabel },
      { label: "对应订单", value: record.usedOrderId || "无订单" },
    ],
    detailTitle: "兑换信息",
    detailFields: [
      { label: "兑换用户", value: record.usedBy || "未记录" },
      { label: "用户 IP", value: record.usedIp || "未记录" },
      { label: "用户浏览器 UA", value: record.usedUserAgent || "未记录", wide: true },
      { label: "兑换时间", value: record.usedAtBeijing || record.usedAt || "未记录" },
      { label: "订单完成时间", value: record.order?.completedAtBeijing || "未完成或无订单" },
    ],
    tableTitle: "用户订单输入内容",
    tableRows: inputRows,
    note,
  });
}

function paymentLabel(order) {
  if (order?.paymentMethod === "redeem") return "服务兑换码";
  if (order?.paymentMethod === "usdt") return "USDT-TRC20";
  return "支付宝";
}

function paidLabel(order) {
  if (order?.paidCurrency === "CODE") return "兑换码抵扣";
  if (order?.paidCurrency === "USDT") return `${order?.paidAmount || 0} USDT`;
  return `¥${order?.paidAmount || 0}`;
}

function pdfText(value, limit = 1000) {
  const text = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .trim();
  return text ? text.slice(0, limit) : "";
}

function orderPdfRows(order) {
  const rows = (Array.isArray(order?.items) ? order.items : [])
    .map((item, index) => {
    const parts = [
      pdfText(item.cycle, 80) ? `周期: ${pdfText(item.cycle, 80)}` : "",
      Number(item.amount || 0) ? `金额: ¥${Number(item.amount || 0).toFixed(2)}` : "",
      pdfText(item.account, 200) ? `用户账号: ${pdfText(item.account, 200)}` : "",
      pdfText(item.password, 200) ? `用户密码: ${pdfText(item.password, 200)}` : "",
      pdfText(item.staffAccount, 200) ? `开通账号: ${pdfText(item.staffAccount, 200)}` : "",
      pdfText(item.staffPassword, 200) ? `开通密码: ${pdfText(item.staffPassword, 200)}` : "",
      pdfText(item.subscriptionLinks?.shadowrocket, 500) ? `Shadowrocket: ${pdfText(item.subscriptionLinks.shadowrocket, 500)}` : "",
      pdfText(item.subscriptionLinks?.clash, 500) ? `Clash: ${pdfText(item.subscriptionLinks.clash, 500)}` : "",
    ].filter(Boolean);
    const label = pdfText(item.label, 120) || `商品 ${index + 1}`;
    if (!parts.length) return null;
    return {
      label: `${index + 1}. ${label}`,
      value: parts.join("\n"),
    };
  })
    .filter(Boolean);
  const buyerRemark = pdfText(order?.remark, 500);
  if (buyerRemark) rows.push({ label: "买家备注", value: buyerRemark });
  const staffNotes = pdfText(order?.staffNotes, 800);
  if (staffNotes) rows.push({ label: "客服备注", value: staffNotes });
  return rows;
}

function exportOrderPdf(order, note = "") {
  if (!order) return;
  openVoucherPdf({
    docTitle: `订单凭证 ${order.orderId || ""}`,
    voucherNo: `OD-${String(order.orderId || "").slice(0, 24)}`,
    eyebrow: "Order Certificate",
    title: "订单详情凭证",
    description: "用于核对订单状态、付款信息、用户资料与商品配置",
    stamp: order.status === "awaiting_quote" ? "待报价" : order.status === "pending_payment" ? "待付款" : order.status === "quote_expired" ? "报价失效" : order.status === "completed" ? "已完成" : order.status === "invalid" ? "无效" : "已收到",
    mainLabel: "Order ID",
    mainValue: order.orderId || "",
    summaryFields: [
      { label: "服务内容", value: order.serviceLabel || "未记录" },
      { label: "实付金额", value: paidLabel(order) },
      { label: "订单状态", value: STATUS_LABEL[order.status] || order.status || "未记录" },
    ],
    detailTitle: "订单信息",
    detailFields: [
      { label: "下单邮箱", value: order.email || "未记录" },
      { label: "联系方式", value: order.contact || "未记录" },
      { label: "下单时间", value: order.createdAtBeijing || "未记录" },
      { label: "完成时间", value: order.completedAtBeijing || "未完成" },
      { label: "支付方式", value: paymentLabel(order) },
      { label: "用户 IP", value: order.clientIp || "未记录" },
      { label: "用户浏览器 UA", value: order.userAgent || "未记录", wide: true },
    ],
    tableTitle: "商品配置与备注",
    tableRows: orderPdfRows(order),
    note,
  });
}

// 环比徽章(今日 vs 昨日)
function DeltaBadge({ cur, prev }) {
  const c = Number(cur || 0), p = Number(prev || 0);
  if (!p && !c) return null;
  const up = c >= p;
  const pct = p > 0 ? Math.round(((c - p) / p) * 100) : 100;
  return <em className={`admin-delta ${up ? "up" : "down"}`}>{up ? "↑" : "↓"}{Math.abs(pct)}%</em>;
}

function customerDetailsRevision(order) {
  return JSON.stringify([
    order?.customerDetailsUpdatedAt || "",
    order?.email || "",
    order?.contact || "",
    order?.remark || "",
    ...(order?.items || []).flatMap((item) => [
      item?.account || "",
      item?.password || "",
      item?.customerPasswordUpdatedAt || "",
      Number(item?.customerPasswordUpdateCount || 0),
    ]),
  ]);
}

export default function AdminPage() {
  const [authed, setAuthed] = useState(null); // null=loading, false=login, true=ok
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [loginOtp, setLoginOtp] = useState("");        // 2FA 动态码/备用码
  const [loginNeed2fa, setLoginNeed2fa] = useState(false);
  const [currentStaff, setCurrentStaff] = useState(null);
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  useSiteSettings(); // 站点设置(PDF 凭证品牌/版权等随设置)
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ordersLoadingMore, setOrdersLoadingMore] = useState(false);
  const [ordersMeta, setOrdersMeta] = useState({ filteredCount: 0, total: 0, hasMore: false });
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
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
  const [spotifyPasswordMail, setSpotifyPasswordMail] = useState(null);
  const [spotifyPasswordMailBusy, setSpotifyPasswordMailBusy] = useState(false);

  // Batch selection state
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResult, setBatchResult] = useState(null);
  const [batchConfirm, setBatchConfirm] = useState(null); // null | "delete" | "invalid"

  // User/balance management
  const [tab, setTab] = useState("overview"); // overview | orders | abnormal | users | balance | staff
  const [navOpen, setNavOpen] = useState(false); // 移动端侧栏抽屉开关(纯 UI)
  const [confirmUserAction, setConfirmUserAction] = useState(null); // { email, action: "ban" | "unban" | "delete" }
  const [userActionBusy, setUserActionBusy] = useState(false);
  const [userInfo, setUserInfo] = useState(null); // {user, transactions}
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [userModalTarget, setUserModalTarget] = useState("");
  const [userTab, setUserTab] = useState("balance"); // balance | referral | activity
  const loadUserRequestRef = useRef(0);
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
  const [logBatchMode, setLogBatchMode] = useState(false);
  const [selectedLogIds, setSelectedLogIds] = useState(new Set());
  const [logDeleteBusy, setLogDeleteBusy] = useState(false);
  const [logDeleteResult, setLogDeleteResult] = useState(null);

  // All registered users
  const [allUsers, setAllUsers] = useState({ users: [], total: 0 });
  const [userListQuery, setUserListQuery] = useState("");
  const [userListLoading, setUserListLoading] = useState(false);

  // Withdrawals + redeem codes
  const [withdrawals, setWithdrawals] = useState([]);
  const [withdrawalLoading, setWithdrawalLoading] = useState(false);
  const [activeWithdrawal, setActiveWithdrawal] = useState(null);
  const [withdrawalStatus, setWithdrawalStatus] = useState("pending");
  const [withdrawalNote, setWithdrawalNote] = useState("");
  const [withdrawalBusy, setWithdrawalBusy] = useState(false);
  const [withdrawalBatchMode, setWithdrawalBatchMode] = useState(false);
  const [selectedWithdrawalIds, setSelectedWithdrawalIds] = useState(new Set());
  const [withdrawalDeleteBusy, setWithdrawalDeleteBusy] = useState(false);
  const [withdrawalDeleteResult, setWithdrawalDeleteResult] = useState(null);
  const [codes, setCodes] = useState([]);
  const [codeBatches, setCodeBatches] = useState([]);
  const [codesLoading, setCodesLoading] = useState(false);
  const [codeType, setCodeType] = useState("service");
  const [codeAmount, setCodeAmount] = useState("");
  const [codeQuantity, setCodeQuantity] = useState("1");
  const [codeRemark, setCodeRemark] = useState("");
  const [codeCustom, setCodeCustom] = useState("");
  const [codeServices, setCodeServices] = useState([]);
  const [codeBusy, setCodeBusy] = useState("");
  const [codeResult, setCodeResult] = useState(null);
  const [activeCodeBatch, setActiveCodeBatch] = useState(null);
  const [redeemHistory, setRedeemHistory] = useState([]);
  const [redeemHistoryQuery, setRedeemHistoryQuery] = useState("");
  const [redeemHistoryLoading, setRedeemHistoryLoading] = useState(false);
  const [redeemHistoryBatchMode, setRedeemHistoryBatchMode] = useState(false);
  const [selectedRedeemHistoryCodes, setSelectedRedeemHistoryCodes] = useState(new Set());
  const [redeemHistoryDeleteBusy, setRedeemHistoryDeleteBusy] = useState(false);
  const [activeRedeemHistory, setActiveRedeemHistory] = useState(null);
  const [pdfExportModal, setPdfExportModal] = useState(null); // { type: "redeem" | "order", record, note }
  const [sendCodeModal, setSendCodeModal] = useState(null); // { code, type, label } | null
  const [sendCodeEmail, setSendCodeEmail] = useState("");
  const [sendCodeBusy, setSendCodeBusy] = useState(false);
  const [sendCodeResult, setSendCodeResult] = useState(null);
  const [staffPane, setStaffPane] = useState({ staff: [], actions: [] });
  const [selectedActionIds, setSelectedActionIds] = useState(new Set());
  const [actionDeleteBusy, setActionDeleteBusy] = useState(false);
  const [actionDeleteResult, setActionDeleteResult] = useState(null);
  const [activeStaffAction, setActiveStaffAction] = useState(null);
  const [staffForm, setStaffForm] = useState({ username: "", password: "", role: "operator", remark: "" });
  const [staffBusy, setStaffBusy] = useState("");
  const [actionSearch, setActionSearch] = useState(""); // 操作日志搜索
  // 员工管理弹窗(细粒度权限/重置密码/强制下线/启停用)
  const [staffManage, setStaffManage] = useState(null); // { staff, perms, role, remark, password }
  const [staffManageBusy, setStaffManageBusy] = useState("");
  const [staffManageMsg, setStaffManageMsg] = useState(null);
  const [staffResult, setStaffResult] = useState(null);
  const [mailLogs, setMailLogs] = useState([]);
  const [mailSearch, setMailSearch] = useState("");
  const [mailForm, setMailForm] = useState({ to: "", subject: "客服服务通知", content: "" });
  const [mailLoading, setMailLoading] = useState(false);
  const [mailBusy, setMailBusy] = useState(false);
  const [mailResult, setMailResult] = useState(null);
  const [mailMode, setMailMode] = useState("customer");
  const [mailLogType, setMailLogType] = useState("customer");
  const [mailRecipientBusy, setMailRecipientBusy] = useState(false);
  const [mailBatchProgress, setMailBatchProgress] = useState(null);
  const [mailMarketingHtml, setMailMarketingHtml] = useState("");
  const [mailMarketingLoading, setMailMarketingLoading] = useState(false);
  const [mailRecipientPool, setMailRecipientPool] = useState({ emails: [], registered: 0, orders: 0, label: "" });
  const [mailBatchMode, setMailBatchMode] = useState(false);
  const [selectedMailIds, setSelectedMailIds] = useState(new Set());
  const [mailDeleteBusy, setMailDeleteBusy] = useState(false);
  const [mailComposeOpen, setMailComposeOpen] = useState(false);
  const [mailTemplates, setMailTemplates] = useState([]); // 快捷模板
  const [mailTplBusy, setMailTplBusy] = useState(false);
  const [activeMailLog, setActiveMailLog] = useState(null);
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [usdtChecking, setUsdtChecking] = useState(false);
  const [usdtCheckMsg, setUsdtCheckMsg] = useState("");
  const usdtCheckingRef = useRef(false);
  const [newOrderAlert, setNewOrderAlert] = useState(null);
  const [highlightOrderIds, setHighlightOrderIds] = useState(new Set());
  const overviewRef = useRef(null);
  // 全局搜索(⌘K)
  const [searchOpen, setSearchOpen] = useState(false);
  const [gQuery, setGQuery] = useState("");
  const [gResults, setGResults] = useState({ orders: [], users: [], codes: [] });
  const [gLoading, setGLoading] = useState(false);

  const isRootStaff = Boolean(currentStaff?.root || Number(currentStaff?.id || 0) === 1);
  const staffPermissions = currentStaff?.permissions || null;
  const permissionsReady = Boolean(staffPermissions) || isRootStaff;
  const canReviewWithdrawals = permissionsReady ? Boolean(staffPermissions?.canReviewWithdrawals ?? isRootStaff) : false;
  const canViewCodes = permissionsReady ? Boolean(staffPermissions?.canViewCodes ?? isRootStaff) : false;
  const canManageCodes = permissionsReady ? Boolean(staffPermissions?.canManageCodes ?? isRootStaff) : false;
  const canSendRedeemCodes = permissionsReady ? Boolean(staffPermissions?.canSendRedeemCodes ?? isRootStaff) : false;
  const canSendMail = permissionsReady ? Boolean(staffPermissions?.canSendMail ?? isRootStaff) : false;
  const canAdjustBalance = permissionsReady ? Boolean(staffPermissions?.canAdjustBalance ?? isRootStaff) : false;
  const canViewBalanceLog = permissionsReady ? Boolean(staffPermissions?.canViewBalanceLog ?? isRootStaff) : false;
  const canViewUsers = permissionsReady ? Boolean(staffPermissions?.canViewUsers ?? isRootStaff) : false;
  const canBanUsers = permissionsReady ? Boolean(staffPermissions?.canBanUsers ?? isRootStaff) : false;
  const canDeleteUsers = permissionsReady ? Boolean(staffPermissions?.canDeleteUsers ?? isRootStaff) : false;
  const canDeleteRecords = permissionsReady ? Boolean(staffPermissions?.canDeleteRecords ?? isRootStaff) : false;
  const canManageStock = permissionsReady ? Boolean(staffPermissions?.canManageStock ?? isRootStaff) : false;
  const canEditOrders = permissionsReady ? Boolean(staffPermissions?.canEditOrders ?? isRootStaff) : false;

  const applyCurrentStaff = useCallback((staff) => {
    if (!staff) return;
    setCurrentStaff((current) => ({
      ...(current || {}),
      ...staff,
      role: staff.role || current?.role || (staff.root ? "owner" : "operator"),
      permissions: staff.permissions || current?.permissions || null,
    }));
  }, []);

  const triggerNewOrderNotice = useCallback((next, previous) => {
    const count = Math.max(1, Number(next.ordersTotal || 0) - Number(previous?.ordersTotal || 0));
    setNewOrderAlert({
      count,
      orderId: next.latestOrderId || "",
      service: next.latestOrderService || "",
      time: next.latestOrderTime || "",
    });
    if (next.latestOrderId) {
      setHighlightOrderIds((current) => new Set([...Array.from(current), next.latestOrderId]));
    }
    if (typeof window !== "undefined") {
      try { window.navigator?.vibrate?.([80, 35, 80]); } catch (e) {}
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = 880;
          gain.gain.setValueAtTime(0.0001, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.055, ctx.currentTime + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.24);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.26);
          setTimeout(() => ctx.close?.(), 450);
        }
      } catch (e) {}
    }
  }, []);

  const loadOverview = useCallback(async (options = {}) => {
    const silent = Boolean(options.silent);
    const watch = Boolean(options.watch);
    if (!silent) setOverviewLoading(true);
    try {
      const res = await fetch("/api/admin/overview", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const data = await res.json();
      if (data.ok) {
        if (data.currentStaff) applyCurrentStaff(data.currentStaff);
        const previous = overviewRef.current;
        const nextOverview = data.overview || null;
        if (
          watch &&
          previous?.latestOrderId &&
          nextOverview?.latestOrderId &&
          nextOverview.latestOrderId !== previous.latestOrderId &&
          Number(nextOverview.ordersTotal || 0) > Number(previous.ordersTotal || 0)
        ) {
          triggerNewOrderNotice(nextOverview, previous);
        }
        overviewRef.current = nextOverview;
        setOverview(nextOverview);
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setOverviewLoading(false);
    }
  }, [triggerNewOrderNotice, applyCurrentStaff]);

  const runUsdtCheck = useCallback(async (manual = false) => {
    if (usdtCheckingRef.current) return;
    usdtCheckingRef.current = true;
    setUsdtChecking(true);
    try {
      const response = await fetch("/api/admin/usdt-check", { method: "POST", credentials: "same-origin" });
      const data = await response.json();
      if (manual) {
        const message = data.disabled
          ? "链上自动确认尚未开启"
          : data.busy
          ? "链上检查正在执行，请稍后查看"
          : data.ok
          ? `已扫描 ${data.scanned ?? 0} 笔，确认 ${data.matched ?? 0} 单${data.ambiguous ? `，${data.ambiguous} 笔待人工核对` : ""}`
          : "链上检查失败，请稍后重试";
        setUsdtCheckMsg(message);
        setTimeout(() => setUsdtCheckMsg(""), 5000);
      }
      if (data.ok && Number(data.matched || 0) > 0) await loadOverview({ silent: true });
    } catch (e) {
      if (manual) {
        setUsdtCheckMsg("链上检查失败，请稍后重试");
        setTimeout(() => setUsdtCheckMsg(""), 5000);
      }
    } finally {
      usdtCheckingRef.current = false;
      setUsdtChecking(false);
    }
  }, [loadOverview]);

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
        if (data.currentStaff) applyCurrentStaff(data.currentStaff);
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
  }, [applyCurrentStaff]);

  const loadWithdrawals = useCallback(async () => {
    setWithdrawalLoading(true);
    try {
      const res = await fetch("/api/admin/withdrawals", { credentials: "same-origin" });
      if (res.status === 401) { setAuthed(false); return; }
      const data = await res.json();
      if (data.ok) {
        if (data.currentStaff) applyCurrentStaff(data.currentStaff);
        setWithdrawals(data.withdrawals || []);
      }
    } catch (e) {} finally {
      setWithdrawalLoading(false);
    }
  }, [applyCurrentStaff]);

  const loadCodes = useCallback(async () => {
    setCodesLoading(true);
    try {
      const res = await fetch("/api/admin/redeem-codes", { credentials: "same-origin" });
      if (res.status === 401) { setAuthed(false); return; }
      const data = await res.json();
      if (data.ok) {
        setCodes(data.codes || []);
        setCodeBatches(data.batches || []);
      }
    } catch (e) {} finally {
      setCodesLoading(false);
    }
  }, []);

  const loadRedeemHistory = useCallback(async (q = "") => {
    setRedeemHistoryLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      const res = await fetch("/api/admin/redeem-history?" + params.toString(), { credentials: "same-origin" });
      if (res.status === 401) { setAuthed(false); return; }
      const data = await res.json();
      if (data.ok) {
        if (data.currentStaff) applyCurrentStaff(data.currentStaff);
        const nextHistory = data.history || [];
        setRedeemHistory(nextHistory);
        const visibleCodes = new Set(nextHistory.map((item) => item.code));
        setSelectedRedeemHistoryCodes((current) => new Set(Array.from(current).filter((code) => visibleCodes.has(code))));
      }
    } catch (e) {} finally {
      setRedeemHistoryLoading(false);
    }
  }, [applyCurrentStaff]);

  const loadStaff = useCallback(async () => {
    try {
      const [res, actionRes] = await Promise.all([
        fetch("/api/admin/staff", { credentials: "same-origin" }),
        fetch("/api/admin/actions", { credentials: "same-origin" }),
      ]);
      if (res.status === 401) { setAuthed(false); return; }
      const data = await res.json();
      const actionData = actionRes.ok ? await actionRes.json() : null;
      if (data.ok) {
        applyCurrentStaff(data.currentStaff || { id: data.currentStaffId, root: data.currentStaffRoot });
        const actions = actionData?.ok ? (actionData.actions || []) : (data.actions || []);
        setStaffPane({ staff: data.staff || [], actions });
        setSelectedActionIds((current) => new Set(Array.from(current).filter((id) => actions.some((item) => item.id === id))));
      }
    } catch (e) {}
  }, [applyCurrentStaff]);

  const loadMailLogs = useCallback(async () => {
    setMailLoading(true);
    try {
      const res = await fetch("/api/admin/mail", { credentials: "same-origin" });
      if (res.status === 401) { setAuthed(false); return; }
      const data = await res.json();
      if (data.ok) {
        if (data.currentStaff) applyCurrentStaff(data.currentStaff);
        setMailLogs(data.logs || []);
      }
    } catch (e) {} finally {
      setMailLoading(false);
    }
  }, [applyCurrentStaff]);

  const loadMailTemplates = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/mail-templates", { credentials: "same-origin", cache: "no-store" });
      const data = await res.json();
      if (data.ok) setMailTemplates(data.templates || []);
    } catch (e) {}
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

  // Load user list when entering users tab; load global log on balance tab
  useEffect(() => {
    if (!authed || !permissionsReady) return;
    if (tab === "users") {
      if (canViewUsers) loadAllUsers(userListQuery);
      else setTab("orders");
    }
    if (tab === "balance") {
      if (canViewBalanceLog) loadGlobalLog(logQuery, logFilter, logSource);
      else setTab("orders");
    }
    if (tab === "withdrawals") {
      if (canReviewWithdrawals) loadWithdrawals();
      else setTab("orders");
    }
    if (tab === "codes") {
      if (canViewCodes) {
        loadCodes();
        if (canManageCodes) loadRedeemHistory(redeemHistoryQuery);
      } else {
        setTab("orders");
      }
    }
    if (tab === "mail") {
      if (canSendMail) { loadMailLogs(); loadMailTemplates(); }
      else setTab("orders");
    }
    if (tab === "staff") {
      if (isRootStaff) loadStaff();
      else if (currentStaff) setTab("orders");
    }
  }, [
    authed, permissionsReady, tab, loadGlobalLog, loadAllUsers, loadWithdrawals, loadCodes,
    loadRedeemHistory, loadMailLogs, loadMailTemplates, loadStaff, logFilter, logSource, isRootStaff,
    currentStaff?.id, canViewUsers, canViewBalanceLog, canReviewWithdrawals,
    canViewCodes, canManageCodes, canSendMail, canManageStock,
  ]);

  useEffect(() => {
    if (!authed) return;
    loadOverview();
  }, [authed, loadOverview]);

  useEffect(() => {
    if (!authed || !overview?.usdtAutoConfirm) return;
    runUsdtCheck();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      runUsdtCheck();
    }, 60000);
    return () => clearInterval(timer);
  }, [authed, overview?.usdtAutoConfirm, runUsdtCheck]);

  useEffect(() => {
    if (permissionsReady && !canManageCodes && codeType === "history") {
      setCodeType("service");
    }
  }, [permissionsReady, canManageCodes, codeType]);

  useEffect(() => {
    if (!authed) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      loadOverview({ silent: true, watch: true });
    }, 10000);
    return () => clearInterval(timer);
  }, [authed, loadOverview]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const original = document.title || "冒央会社后台";
    if (newOrderAlert) {
      document.title = `(${newOrderAlert.count}) 新订单 · 冒央会社后台`;
    }
    return () => { document.title = original; };
  }, [newOrderAlert]);

  // ⌘K / Ctrl+K 打开全局搜索
  useEffect(() => {
    if (!authed) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (e.key === "Escape") {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authed]);

  // 全局搜索:防抖查询
  useEffect(() => {
    if (!searchOpen) return;
    const q = gQuery.trim();
    if (q.length < 2) { setGResults({ orders: [], users: [], codes: [] }); setGLoading(false); return; }
    setGLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch("/api/admin/search?q=" + encodeURIComponent(q), { credentials: "same-origin" });
        const j = await r.json();
        if (j.ok) setGResults({ orders: j.orders || [], users: j.users || [], codes: j.codes || [] });
      } catch (e) {} finally { setGLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [gQuery, searchOpen]);

  function closeSearch() { setSearchOpen(false); setGQuery(""); setGResults({ orders: [], users: [], codes: [] }); }
  function searchGotoOrder(orderId) { closeSearch(); setTab("orders"); setFilterStatus("all"); setDateFrom(""); setDateTo(""); setSearchInput(orderId); setAppliedSearch(orderId); }
  function searchGotoUser(email) { closeSearch(); loadUser(email); }
  function searchGotoCode() { closeSearch(); setTab("codes"); }

  useEffect(() => {
    if (!pdfExportModal || typeof window === "undefined" || typeof document === "undefined") return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    function syncViewport() {
      const height = viewport?.height || window.innerHeight;
      const top = viewport?.offsetTop || 0;
      root.style.setProperty("--admin-visual-height", `${height}px`);
      root.style.setProperty("--admin-visual-top", `${top}px`);
    }
    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
      root.style.removeProperty("--admin-visual-height");
      root.style.removeProperty("--admin-visual-top");
    };
  }, [pdfExportModal]);

  async function executeUserAction() {
    if (!confirmUserAction || userActionBusy) return;
    setUserActionBusy(true);
    try {
      const { email, action } = confirmUserAction;
      if (action === "delete" && !canDeleteUsers) {
        setUserError("仅主账号可删除用户");
        setConfirmUserAction(null);
        return;
      }
      if ((action === "ban" || action === "unban") && !canBanUsers) {
        setUserError("当前账号不可封禁或解禁用户");
        setConfirmUserAction(null);
        return;
      }
      let res;
      if (action === "delete") {
        res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, {
          method: "DELETE", credentials: "same-origin",
        });
      } else {
        res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, {
          method: "PATCH", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ banned: action === "ban" }),
        });
      }
      const data = await res.json();
      if (data.ok) {
        setConfirmUserAction(null);
        loadAllUsers(userListQuery);
        if (userInfo && userInfo.user.email === confirmUserAction.email && action === "delete") {
          setUserInfo(null);
          setUserModalOpen(false);
        }
      }
    } catch (e) {} finally {
      setUserActionBusy(false);
    }
  }

  function closeUserModal() {
    if (balBusy) return;
    loadUserRequestRef.current += 1;
    setUserModalOpen(false);
    setUserModalTarget("");
    setUserTab("balance"); // 下次打开默认回到「余额明细」
  }

  async function loadUser(email) {
    if (!email) return;
    const nextEmail = email.trim();
    const requestId = ++loadUserRequestRef.current;
    setUserModalTarget(nextEmail);
    setUserModalOpen(true);
    setUserInfo((current) => current?.user?.email === nextEmail ? current : null);
    setUserLoading(true);
    setUserError("");
    setBalResult(null);
    try {
      const res = await fetch(`/api/admin/users?email=${encodeURIComponent(nextEmail)}`, {
        credentials: "same-origin",
      });
      const data = await res.json();
      if (requestId !== loadUserRequestRef.current) return;
      if (data.ok) {
        setUserInfo(data);
        setUserModalOpen(true);
      } else {
        setUserInfo(null);
        setUserModalOpen(false);
        setUserModalTarget("");
        setUserError(data.error === "user_not_found" ? "未找到该邮箱的注册用户" : (data.error || "查询失败"));
      }
    } catch (e) {
      if (requestId !== loadUserRequestRef.current) return;
      setUserModalOpen(false);
      setUserModalTarget("");
      setUserError("网络错误");
    } finally {
      if (requestId === loadUserRequestRef.current) setUserLoading(false);
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
    if (!canAdjustBalance) {
      setBalResult({ type: "error", message: "当前账号不可调整余额" });
      return;
    }
    const num = Number(balForm.amount);
    if (!Number.isFinite(num) || num <= 0) {
      setBalResult({ type: "error", message: "请输入正数金额" });
      return;
    }
    if (!balForm.reason.trim()) {
      setBalResult({ type: "error", message: "请填写原因(将记入余额明细)" });
      return;
    }
    // 改余额二次确认
    if (typeof window !== "undefined" && !window.confirm(`确认给 ${userInfo.user.email} ${sign > 0 ? "增加" : "扣除"} ¥${num.toFixed(2)}？`)) return;
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

  async function openWithdrawal(id) {
    setWithdrawalBusy(true);
    try {
      const res = await fetch(`/api/admin/withdrawals/${encodeURIComponent(id)}`, { credentials: "same-origin" });
      const data = await res.json();
      if (data.ok) {
        setActiveWithdrawal(data);
        setWithdrawalStatus(data.withdrawal.status || "pending");
        setWithdrawalNote(data.withdrawal.reviewNote || "");
      }
    } catch (e) {} finally {
      setWithdrawalBusy(false);
    }
  }

  async function saveWithdrawalStatus(e) {
    e.preventDefault();
    if (!activeWithdrawal || withdrawalBusy) return;
    setWithdrawalBusy(true);
    try {
      const res = await fetch(`/api/admin/withdrawals/${encodeURIComponent(activeWithdrawal.withdrawal.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: withdrawalStatus, reviewNote: withdrawalNote }),
      });
      const data = await res.json();
      if (data.ok) {
        setActiveWithdrawal(data);
        await loadWithdrawals();
      }
    } catch (e) {} finally {
      setWithdrawalBusy(false);
    }
  }

  function toggleWithdrawalSelect(id) {
    setSelectedWithdrawalIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleLogSelect(id) {
    setSelectedLogIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteSelectedWithdrawals() {
    if (!canDeleteRecords || withdrawalDeleteBusy || selectedWithdrawalIds.size === 0) return;
    if (typeof window !== "undefined" && !window.confirm(`确认删除 ${selectedWithdrawalIds.size} 条提现审核记录？`)) return;
    setWithdrawalDeleteBusy(true);
    setWithdrawalDeleteResult(null);
    try {
      const ids = Array.from(selectedWithdrawalIds);
      const res = await fetch("/api/admin/withdrawals", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (data.ok) {
        setSelectedWithdrawalIds(new Set());
        setWithdrawalBatchMode(false);
        if (activeWithdrawal && ids.includes(activeWithdrawal.withdrawal.id)) setActiveWithdrawal(null);
        setWithdrawalDeleteResult({ type: "success", message: `已删除 ${data.deletedCount || ids.length} 条提现记录` });
        await loadWithdrawals();
      } else {
        setWithdrawalDeleteResult({ type: "error", message: data.error === "forbidden" ? "仅主账号可批量删除" : (data.error || "删除失败") });
      }
    } catch (e) {
      setWithdrawalDeleteResult({ type: "error", message: "网络错误" });
    } finally {
      setWithdrawalDeleteBusy(false);
    }
  }

  async function deleteSelectedBalanceLogs() {
    if (!canDeleteRecords || logDeleteBusy || selectedLogIds.size === 0) return;
    if (typeof window !== "undefined" && !window.confirm(`确认删除 ${selectedLogIds.size} 条余额变动记录？`)) return;
    setLogDeleteBusy(true);
    setLogDeleteResult(null);
    try {
      const ids = Array.from(selectedLogIds);
      const res = await fetch("/api/admin/balance-log", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (data.ok) {
        setSelectedLogIds(new Set());
        setLogBatchMode(false);
        setLogDeleteResult({ type: "success", message: `已删除 ${data.deletedCount || ids.length} 条余额记录` });
        await loadGlobalLog(logQuery, logFilter, logSource);
      } else {
        setLogDeleteResult({ type: "error", message: data.error === "forbidden" ? "仅主账号可批量删除" : (data.error || "删除失败") });
      }
    } catch (e) {
      setLogDeleteResult({ type: "error", message: "网络错误" });
    } finally {
      setLogDeleteBusy(false);
    }
  }

  function toggleMailSelect(id) {
    setSelectedMailIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applyMailComposerMode(nextMode) {
    setMailMode(nextMode);
    setMailResult(null);
    setMailBatchProgress(null);
    setMailForm((current) => {
      if (nextMode === "marketing") {
        return {
          ...current,
          subject: MARKETING_MAIL_SUBJECT,
          content: MARKETING_MAIL_PREVIEW,
        };
      }
      return {
        ...current,
        subject: current.subject === MARKETING_MAIL_SUBJECT ? "客服服务通知" : (current.subject || "客服服务通知"),
        content: current.content === MARKETING_MAIL_PREVIEW ? "" : current.content,
      };
    });
  }

  function openMailComposer(nextMode = "customer") {
    applyMailComposerMode(nextMode);
    setMailComposeOpen(true);
    if (nextMode === "marketing") loadMarketingMailTemplate();
  }

  function buildMailPayload(to = mailForm.to) {
    if (mailMode === "marketing") {
      return {
        to,
        subject: mailForm.subject || MARKETING_MAIL_SUBJECT,
        content: MARKETING_MAIL_PREVIEW,
        template: MARKETING_MAIL_TEMPLATE_ID,
        html: mailMarketingHtml,
      };
    }
    return {
      to,
      subject: mailForm.subject,
      content: mailForm.content,
    };
  }

  async function loadMarketingMailTemplate(force = false) {
    if (mailMarketingLoading || (!force && mailMarketingHtml.trim())) return;
    setMailMarketingLoading(true);
    try {
      const res = await fetch(`/api/admin/mail?template=${encodeURIComponent(MARKETING_MAIL_TEMPLATE_ID)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json();
      if (data.ok) {
        setMailMarketingHtml(data.html || "");
        setMailForm((current) => ({
          ...current,
          subject: current.subject && current.subject !== "客服服务通知" ? current.subject : (data.subject || MARKETING_MAIL_SUBJECT),
          content: data.preview || MARKETING_MAIL_PREVIEW,
        }));
      } else {
        setMailResult({ type: "error", message: data.error === "forbidden" ? "当前工作人员没有发信权限" : (data.error || "读取营销邮件模板失败") });
      }
    } catch (e) {
      setMailResult({ type: "error", message: "读取营销邮件模板失败，请稍后重试" });
    } finally {
      setMailMarketingLoading(false);
    }
  }

  async function fetchRegisteredMailEmails() {
    if (!canViewUsers) {
      setMailResult({ type: "error", message: "读取注册用户邮箱需要用户查看权限" });
      return [];
    }
    const res = await fetch("/api/admin/users/list", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await res.json();
    if (!data.ok) {
      const msg = {
        unauthorized: "登录状态已失效，请重新登录后台",
        forbidden: "当前工作人员没有查看用户权限",
      }[data.error] || data.error || "读取注册用户邮箱失败";
      throw new Error(msg);
    }
    return normalizeEmailList((data.users || []).map((user) => user?.email));
  }

  async function fetchOrderMailEmails() {
    const emails = [];
    let offset = 0;
    const limit = 200;
    while (true) {
      const params = new URLSearchParams();
      params.set("offset", String(offset));
      params.set("limit", String(limit));
      const res = await fetch("/api/admin/orders?" + params.toString(), {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await res.json();
      if (!data.ok) {
        const msg = {
          unauthorized: "登录状态已失效，请重新登录后台",
          forbidden: "当前工作人员没有查看订单权限",
        }[data.error] || data.error || "读取历史订单邮箱失败";
        throw new Error(msg);
      }
      const orders = Array.isArray(data.orders) ? data.orders : [];
      orders.forEach((order) => {
        emails.push(order?.email);
        emails.push(...extractEmailsFromText(order?.contact));
      });
      offset += orders.length;
      if (!data.hasMore || orders.length === 0) break;
    }
    return normalizeEmailList(emails);
  }

  async function loadMarketingRecipientPool(source = "all") {
    if (mailRecipientBusy) return;
    setMailRecipientBusy(true);
    setMailBatchProgress(null);
    try {
      let registered = [];
      let orders = [];
      if (source === "registered" || source === "all") registered = await fetchRegisteredMailEmails();
      if (source === "orders" || source === "all") orders = await fetchOrderMailEmails();
      const emails = normalizeEmailList([...registered, ...orders]);
      const label = source === "registered" ? "注册用户" : source === "orders" ? "历史订单联系邮箱" : "注册用户 + 历史订单";
      setMailRecipientPool({ emails, registered: registered.length, orders: orders.length, label });
      setMailResult({
        type: emails.length > 0 ? "success" : "error",
        message: emails.length > 0
          ? `已读取 ${label}：去重后 ${emails.length} 个邮箱。批量发送会按每批 ${MAIL_BATCH_LIMIT} 个自动发完，不会只发送前 ${MAIL_BATCH_LIMIT} 个。`
          : "没有读取到可用邮箱。",
      });
    } catch (e) {
      setMailResult({ type: "error", message: e?.message || "读取邮箱失败，请稍后重试" });
    } finally {
      setMailRecipientBusy(false);
    }
  }

  async function fillRegisteredMailRecipients() {
    await loadMarketingRecipientPool("registered");
  }

  async function fillOrderMailRecipients() {
    await loadMarketingRecipientPool("orders");
  }

  async function fillAllMarketingRecipients() {
    await loadMarketingRecipientPool("all");
  }

  async function sendMarketingMailToRegisteredUsers() {
    if (mailBusy || mailRecipientBusy) return;
    if (mailMode !== "marketing") applyMailComposerMode("marketing");
    if (!mailMarketingHtml.trim()) {
      setMailResult({ type: "error", message: "请先等待营销邮件 HTML 模板加载完成，或手动填写 HTML" });
      return;
    }
    const emails = mailRecipientPool.emails || [];
    if (emails.length === 0) {
      setMailResult({ type: "error", message: "请先读取注册用户或历史订单邮箱，再执行批量发送" });
      return;
    }
    if (typeof window !== "undefined" && !window.confirm(`确认向已读取的 ${emails.length} 个邮箱发送这封营销邮件？系统会按每批 ${MAIL_BATCH_LIMIT} 个自动发完。`)) {
      return;
    }
    const batches = splitIntoBatches(emails, MAIL_BATCH_LIMIT);
    let sentTotal = 0;
    let failedTotal = 0;
    setMailBusy(true);
    setMailBatchProgress({ sent: 0, failed: 0, total: emails.length, batch: 0, batches: batches.length });
    try {
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        const res = await fetch("/api/admin/mail", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: batch.join(", "),
            subject: mailForm.subject || MARKETING_MAIL_SUBJECT,
            content: MARKETING_MAIL_PREVIEW,
            template: MARKETING_MAIL_TEMPLATE_ID,
            html: mailMarketingHtml,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          sentTotal += Number(data.sentCount || batch.length);
          failedTotal += Number(data.failedCount || 0);
        } else {
          failedTotal += batch.length;
        }
        setMailBatchProgress({
          sent: sentTotal,
          failed: failedTotal,
          total: emails.length,
          batch: index + 1,
          batches: batches.length,
        });
      }
      setMailResult({
        type: failedTotal > 0 ? "error" : "success",
        message: failedTotal > 0
          ? `营销邮件已发送 ${sentTotal} 封，失败 ${failedTotal} 封，请查看发信记录。`
          : `营销邮件已发送 ${sentTotal} 封，并已写入发信记录。`,
      });
      await loadMailLogs();
    } catch (e) {
      setMailResult({ type: "error", message: "批量发送失败，请检查网络或 SMTP 配置后重试" });
      await loadMailLogs();
    } finally {
      setMailBusy(false);
    }
  }

  // ── 客服发信快捷模板 ──
  async function saveMailTemplate() {
    if (mailTplBusy) return;
    if (!mailForm.content.trim()) { setMailResult({ type: "error", message: "先填写正文再存为模板" }); return; }
    const name = typeof window !== "undefined" ? window.prompt("模板名称(如:发货通知/售后跟进):", mailForm.subject.slice(0, 20)) : "";
    if (!name || !name.trim()) return;
    setMailTplBusy(true);
    try {
      const res = await fetch("/api/admin/mail-templates", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), subject: mailForm.subject, content: mailForm.content }),
      });
      const data = await res.json();
      if (data.ok) setMailTemplates(data.templates || []);
      else setMailResult({ type: "error", message: data.error || "保存模板失败" });
    } catch (e) {} finally { setMailTplBusy(false); }
  }

  async function deleteMailTemplate(id, name) {
    if (mailTplBusy) return;
    if (typeof window !== "undefined" && !window.confirm(`删除模板「${name}」?`)) return;
    setMailTplBusy(true);
    try {
      const res = await fetch("/api/admin/mail-templates", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data.ok) setMailTemplates(data.templates || []);
    } catch (e) {} finally { setMailTplBusy(false); }
  }

  async function sendCustomerMail(e) {
    e.preventDefault();
    if (mailBusy) return;
    const isMarketing = mailMode === "marketing";
    if (isMarketing && !mailMarketingHtml.trim()) {
      setMailResult({ type: "error", message: "请先等待营销邮件 HTML 模板加载完成，或手动填写 HTML" });
      return;
    }
    setMailBusy(true);
    setMailResult(null);
    try {
      const res = await fetch("/api/admin/mail", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildMailPayload()),
      });
      const data = await res.json();
      if (data.ok) {
        const sentCount = Number(data.sentCount || 1);
        const failedCount = Number(data.failedCount || 0);
        setMailForm((current) => ({
          ...current,
          to: "",
          content: isMarketing ? MARKETING_MAIL_PREVIEW : "",
        }));
        setMailComposeOpen(false);
        setMailBatchProgress(null);
        setMailResult({
          type: failedCount > 0 ? "error" : "success",
          message: failedCount > 0
            ? `${isMarketing ? "营销邮件" : "邮件"}已发送 ${sentCount} 封，${failedCount} 封失败，请查看发信记录`
            : `${isMarketing ? "营销邮件" : "邮件"}已发送 ${sentCount} 封，并已记录工作人员编号`,
        });
        await loadMailLogs();
      } else {
        const msg = {
          unauthorized: "登录状态已失效，请重新登录后台",
          forbidden: "当前工作人员没有发信权限",
          invalid_email: data.detail ? `邮箱格式错误：${data.detail}` : "请填写正确的收件邮箱",
          too_many_recipients: `单次最多发送 ${data.limit || 20} 个邮箱`,
          content_required: "请填写邮件正文内容",
          smtp_or_to_missing: "SMTP 发信配置不完整",
          send_failed_after_retry: "邮件发送失败，请检查 SMTP 配置或稍后重试",
          send_failed: "邮件发送失败，请检查 SMTP 配置或稍后重试",
        }[data.error] || data.detail || data.error || "发送失败";
        setMailResult({ type: "error", message: msg });
        await loadMailLogs();
      }
    } catch (e) {
      setMailResult({ type: "error", message: "网络错误" });
    } finally {
      setMailBusy(false);
    }
  }

  async function deleteSelectedMailLogs() {
    if (!canDeleteRecords || mailDeleteBusy || selectedMailIds.size === 0) return;
    if (typeof window !== "undefined" && !window.confirm(`确认删除 ${selectedMailIds.size} 条发信记录？`)) return;
    setMailDeleteBusy(true);
    setMailResult(null);
    try {
      const ids = Array.from(selectedMailIds);
      const res = await fetch("/api/admin/mail", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (data.ok) {
        setSelectedMailIds(new Set());
        setMailBatchMode(false);
        if (activeMailLog && ids.includes(activeMailLog.id)) setActiveMailLog(null);
        setMailResult({ type: "success", message: `已删除 ${data.deletedCount || ids.length} 条发信记录` });
        await loadMailLogs();
      } else {
        setMailResult({ type: "error", message: data.error === "forbidden" ? "仅主账号可批量删除" : (data.error || "删除失败") });
      }
    } catch (e) {
      setMailResult({ type: "error", message: "网络错误" });
    } finally {
      setMailDeleteBusy(false);
    }
  }

  function toggleRedeemHistorySelect(code) {
    setSelectedRedeemHistoryCodes((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function selectAllRedeemHistory() {
    setSelectedRedeemHistoryCodes(new Set(redeemHistory.map((item) => item.code).filter(Boolean)));
  }

  async function deleteSelectedRedeemHistory() {
    if (!canManageCodes || !canDeleteRecords || redeemHistoryDeleteBusy || selectedRedeemHistoryCodes.size === 0) return;
    if (typeof window !== "undefined" && !window.confirm(`确认删除 ${selectedRedeemHistoryCodes.size} 条兑换历史？`)) return;
    setRedeemHistoryDeleteBusy(true);
    setCodeResult(null);
    try {
      const codesToDelete = Array.from(selectedRedeemHistoryCodes);
      const res = await fetch("/api/admin/redeem-history", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes: codesToDelete }),
      });
      const data = await res.json();
      if (data.ok) {
        setSelectedRedeemHistoryCodes(new Set());
        setRedeemHistoryBatchMode(false);
        if (activeRedeemHistory && codesToDelete.includes(activeRedeemHistory.code)) setActiveRedeemHistory(null);
        setCodeResult({ type: "success", message: `已删除 ${data.deletedCount || codesToDelete.length} 条兑换历史` });
        await loadRedeemHistory(redeemHistoryQuery);
      } else {
        setCodeResult({ type: "error", message: data.error === "forbidden" ? "仅主账号可批量删除兑换历史" : (data.error || "删除失败") });
      }
    } catch (e) {
      setCodeResult({ type: "error", message: "网络错误" });
    } finally {
      setRedeemHistoryDeleteBusy(false);
    }
  }

  async function createCode(e) {
    e.preventDefault();
    if (codeBusy) return;
    if (!canManageCodes) {
      setCodeResult({ type: "error", message: "当前账号不可创建兑换码" });
      return;
    }
    if (codeType === "service" && codeServices.length === 0) {
      setCodeResult({ type: "error", message: "请至少选择一个服务" });
      return;
    }
    setCodeBusy("create");
    setCodeResult(null);
    try {
      const res = await fetch("/api/admin/redeem-codes", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: codeType,
          amount: codeAmount,
          services: codeServices,
          quantity: codeQuantity,
          remark: codeRemark,
          customCode: codeCustom,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setCodes(data.codes || []);
        setCodeBatches(data.batches || []);
        setCodeAmount("");
        setCodeQuantity("1");
        setCodeRemark("");
        setCodeCustom("");
        if (codeType === "service") {
          setCodeServices([]);
        }
        setCodeResult({ type: "success", message: `已生成 ${data.generatedCodes?.length || 1} 个兑换码` });
      } else {
        const msg = {
          missing_services: "请选择至少一个服务",
          invalid_custom_code: "自定义代码需为4-40位字母或数字",
          custom_code_exists: "该自定义兑换码已存在,请换一个",
        }[data.error] || "生成失败,请检查金额或服务";
        setCodeResult({ type: "error", message: msg });
      }
    } catch (e) {
      setCodeResult({ type: "error", message: "网络错误" });
    } finally {
      setCodeBusy("");
    }
  }

  function toggleCodeService(entry) {
    const target = typeof entry === "string" ? { key: entry, plan: "" } : { key: entry.key, plan: entry.plan || "" };
    setCodeServices((current) => {
      const list = current.map((item) =>
        typeof item === "string" ? { key: item, plan: "" } : { key: item.key, plan: item.plan || "" }
      );
      const matchIdx = list.findIndex((s) => s.key === target.key && (s.plan || "") === (target.plan || ""));
      if (matchIdx >= 0) return list.filter((_, i) => i !== matchIdx);
      if (hasProductPlans(target.key)) {
        return [...list.filter((s) => s.key !== target.key), target];
      }
      return [...list, target];
    });
  }

  function setCodeServicePlan(productKey, planId) {
    const plan = getProductPlan(productKey, planId);
    const nextPlan = planId && plan ? plan.id : "";
    setCodeServices((current) => {
      const list = current.map((item) =>
        typeof item === "string" ? { key: item, plan: "" } : { key: item.key, plan: item.plan || "" }
      );
      const withoutProduct = list.filter((item) => item.key !== productKey);
      return nextPlan ? [...withoutProduct, { key: productKey, plan: nextPlan }] : withoutProduct;
    });
  }

  async function codeAction(code, action) {
    if (codeBusy) return;
    if (!canManageCodes) {
      setCodeResult({ type: "error", message: "当前账号不可管理兑换码" });
      return;
    }
    if (action === "delete" && !canDeleteRecords) {
      setCodeResult({ type: "error", message: "仅主账号可删除后台数据" });
      return;
    }
    setCodeBusy(action + code);
    setCodeResult(null);
    try {
      const res = await fetch(`/api/admin/redeem-codes/${encodeURIComponent(code)}`, {
        method: action === "delete" ? "DELETE" : "PATCH",
        credentials: "same-origin",
      });
      const data = await res.json();
      if (data.ok) {
        setCodes(data.codes || []);
        setCodeBatches(data.batches || []);
        setCodeResult({ type: "success", message: action === "delete" ? "兑换码已删除" : "兑换码已作废" });
      } else {
        setCodeResult({ type: "error", message: data.error || "操作失败" });
      }
    } catch (e) {
      setCodeResult({ type: "error", message: "网络错误" });
    } finally {
      setCodeBusy("");
    }
  }

  async function codeActionV2(code, action) {
    if (codeBusy) return;
    if (!canManageCodes) {
      setCodeResult({ type: "error", message: "当前账号不可管理兑换码" });
      return;
    }
    if (action === "delete" && !canDeleteRecords) {
      setCodeResult({ type: "error", message: "仅主账号可删除后台数据" });
      return;
    }
    setCodeBusy(action + code);
    setCodeResult(null);
    try {
      const res = await fetch(`/api/admin/redeem-codes/${encodeURIComponent(code)}`, {
        method: action === "delete" ? "DELETE" : "PATCH",
        credentials: "same-origin",
      });
      const data = await res.json();
      if (data.ok) {
        setCodes(data.codes || []);
        setCodeBatches(data.batches || []);
        if (activeCodeBatch) {
          const refreshed = (data.batches || []).find((batch) => batch.id === activeCodeBatch.id);
          if (refreshed) setActiveCodeBatch(refreshed);
          else setActiveCodeBatch(null);
        }
        setCodeResult({ type: "success", message: action === "delete" ? "兑换码已删除" : "兑换码已作废" });
      } else {
        setCodeResult({ type: "error", message: data.error || "操作失败" });
      }
    } catch (e) {
      setCodeResult({ type: "error", message: "网络错误" });
    } finally {
      setCodeBusy("");
    }
  }

  async function batchCodeAction(batchId, action) {
    if (codeBusy) return;
    if (!canManageCodes) {
      setCodeResult({ type: "error", message: "当前账号不可管理兑换码批次" });
      return;
    }
    if (action === "delete" && !canDeleteRecords) {
      setCodeResult({ type: "error", message: "仅主账号可删除后台数据" });
      return;
    }
    setCodeBusy(action + batchId);
    setCodeResult(null);
    try {
      const res = await fetch(`/api/admin/redeem-code-batches/${encodeURIComponent(batchId)}`, {
        method: action === "delete" ? "DELETE" : "PATCH",
        credentials: "same-origin",
      });
      const data = await res.json();
      if (data.ok) {
        setCodes(data.codes || []);
        setCodeBatches(data.batches || []);
        if (action === "delete") setActiveCodeBatch(null);
        else {
          const refreshed = (data.batches || []).find((batch) => batch.id === batchId);
          if (refreshed) setActiveCodeBatch(refreshed);
          else setActiveCodeBatch(null);
        }
        setCodeResult({ type: "success", message: action === "delete" ? "批次已删除" : "批次内可用兑换码已作废" });
      } else {
        setCodeResult({ type: "error", message: data.error || "操作失败" });
      }
    } catch (e) {
      setCodeResult({ type: "error", message: "网络错误" });
    } finally {
      setCodeBusy("");
    }
  }

  async function sendRedeemCodeEmail(e) {
    e.preventDefault();
    if (sendCodeBusy || !sendCodeModal) return;
    if (!canSendRedeemCodes) {
      setSendCodeResult({ type: "error", message: "当前账号不可发送兑换码" });
      return;
    }
    const email = sendCodeEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setSendCodeResult({ type: "error", message: "请填写有效邮箱" });
      return;
    }
    setSendCodeBusy(true);
    setSendCodeResult(null);
    try {
      const res = await fetch(`/api/admin/redeem-codes/${encodeURIComponent(sendCodeModal.code)}/send`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (data.ok) {
        setSendCodeResult({ type: "success", message: `已发送至 ${email}` });
        setTimeout(() => {
          setSendCodeModal(null);
          setSendCodeEmail("");
          setSendCodeResult(null);
        }, 1200);
      } else {
        const msg = {
          invalid_email: "邮箱格式错误",
          code_not_found: "兑换码不存在",
          code_unavailable: "兑换码已使用或已作废，无法发送",
          send_failed: "邮件发送失败，请稍后再试",
        }[data.error] || data.error || "发送失败";
        setSendCodeResult({ type: "error", message: msg });
      }
    } catch (err) {
      setSendCodeResult({ type: "error", message: "网络错误" });
    } finally {
      setSendCodeBusy(false);
    }
  }

  async function createStaff(e) {
    e.preventDefault();
    if (staffBusy) return;
    setStaffBusy("create");
    setStaffResult(null);
    try {
      const res = await fetch("/api/admin/staff", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(staffForm),
      });
      const data = await res.json();
      if (data.ok) {
        await loadStaff();
        setStaffForm({ username: "", password: "", role: "operator", remark: "" });
        setStaffResult({ type: "success", message: `已新增工作人员 #${data.created.id}` });
      } else {
        setStaffResult({ type: "error", message: data.error || "新增失败" });
      }
    } catch (e) {
      setStaffResult({ type: "error", message: "网络错误" });
    } finally {
      setStaffBusy("");
    }
  }

  async function deleteStaff(id) {
    if (staffBusy) return;
    setStaffBusy("delete" + id);
    setStaffResult(null);
    try {
      const res = await fetch(`/api/admin/staff/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = await res.json();
      if (data.ok) {
        await loadStaff();
        setStaffResult({ type: "success", message: "工作人员已删除" });
      } else {
        setStaffResult({ type: "error", message: data.error || "删除失败" });
      }
    } catch (e) {
      setStaffResult({ type: "error", message: "网络错误" });
    } finally {
      setStaffBusy("");
    }
  }

  const STAFF_PERM_LABELS = [
    ["canEditOrders", "处理订单"], ["canViewUsers", "查看用户"], ["canBanUsers", "封禁用户"],
    ["canAdjustBalance", "调整余额"], ["canViewBalanceLog", "余额变动"], ["canViewCodes", "查看兑换码"],
    ["canManageCodes", "管理兑换码"], ["canSendRedeemCodes", "发送兑换码"], ["canReviewWithdrawals", "提现审核"],
    ["canSendMail", "客服发信"], ["canManageStock", "管理库存"],
  ];

  function openStaffManage(item) {
    const perms = {};
    STAFF_PERM_LABELS.forEach(([key]) => { perms[key] = Boolean(item.permissions?.[key]); });
    setStaffManage({ staff: item, perms, role: item.role || "operator", remark: item.remark || "", password: "", active: item.active !== false });
    setStaffManageMsg(null);
  }

  async function saveStaffManage() {
    if (!staffManage || staffManageBusy) return;
    if (staffManage.password && staffManage.password.length < 6) {
      setStaffManageMsg({ type: "error", message: "新密码至少 6 位(留空则不改密)" });
      return;
    }
    setStaffManageBusy("save");
    setStaffManageMsg(null);
    try {
      const res = await fetch(`/api/admin/staff/${encodeURIComponent(staffManage.staff.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          perms: staffManage.perms,
          role: staffManage.role,
          remark: staffManage.remark,
          password: staffManage.password || undefined,
          active: staffManage.active,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        await loadStaff();
        setStaffManageMsg({ type: "success", message: "已保存并踢下线,该员工需重新登录(新权限即刻生效)" });
        setStaffManage((cur) => (cur ? { ...cur, password: "" } : cur));
      } else {
        setStaffManageMsg({ type: "error", message: data.error || "保存失败" });
      }
    } catch (e) {
      setStaffManageMsg({ type: "error", message: "网络错误" });
    } finally {
      setStaffManageBusy("");
    }
  }

  async function kickStaff() {
    if (!staffManage || staffManageBusy) return;
    if (typeof window !== "undefined" && !window.confirm(`确认把 ${staffManage.staff.username} 强制下线？其当前登录将立即失效。`)) return;
    setStaffManageBusy("kick");
    setStaffManageMsg(null);
    try {
      const res = await fetch(`/api/admin/staff/${encodeURIComponent(staffManage.staff.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "kick" }),
      });
      const data = await res.json();
      setStaffManageMsg(data.ok
        ? { type: "success", message: "已强制下线,该员工当前会话立即失效" }
        : { type: "error", message: data.error || "操作失败" });
    } catch (e) {
      setStaffManageMsg({ type: "error", message: "网络错误" });
    } finally {
      setStaffManageBusy("");
    }
  }

  async function resetStaff2fa() {
    if (!staffManage || staffManageBusy) return;
    if (typeof window !== "undefined" && !window.confirm(`确认解除 ${staffManage.staff.username} 的两步验证并踢下线?(用于其丢失验证器)`)) return;
    setStaffManageBusy("reset2fa");
    setStaffManageMsg(null);
    try {
      const res = await fetch(`/api/admin/staff/${encodeURIComponent(staffManage.staff.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset2fa" }),
      });
      const data = await res.json();
      setStaffManageMsg(data.ok
        ? { type: "success", message: "已解除其两步验证并踢下线,可仅用密码重新登录" }
        : { type: "error", message: data.error || "操作失败" });
    } catch (e) {
      setStaffManageMsg({ type: "error", message: "网络错误" });
    } finally {
      setStaffManageBusy("");
    }
  }

  async function deleteSelectedActions() {
    if (selectedActionIds.size === 0 || actionDeleteBusy) return;
    if (typeof window !== "undefined" && !window.confirm(`确认删除 ${selectedActionIds.size} 条操作记录？`)) return;
    setActionDeleteBusy(true);
    setActionDeleteResult(null);
    try {
      const res = await fetch("/api/admin/actions", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedActionIds) }),
      });
      const data = await res.json();
      if (data.ok) {
        setStaffPane((current) => ({ ...current, actions: data.actions || [] }));
        setActiveStaffAction((current) => {
          if (!current) return null;
          return {
            ...current,
            actions: (data.actions || []).filter((action) => Number(action.staffId || 1) === Number(current.staff?.id || 1)),
          };
        });
        setSelectedActionIds(new Set());
        setActionDeleteResult({ type: "success", message: `已删除 ${data.deletedCount || 0} 条操作记录` });
      } else {
        setActionDeleteResult({ type: "error", message: data.error || "删除失败" });
      }
    } catch (e) {
      setActionDeleteResult({ type: "error", message: "网络错误" });
    } finally {
      setActionDeleteBusy(false);
    }
  }

  function openStaffActionModal(staff) {
    const staffId = Number(staff?.id || 1);
    setSelectedActionIds(new Set());
    setActionDeleteResult(null);
    setActiveStaffAction({
      staff,
      actions: staffPane.actions.filter((action) => Number(action.staffId || 1) === staffId),
    });
  }

  // Try fetching orders to detect if authed
  const loadOrders = useCallback(async (q, status, options = {}) => {
    const silent = Boolean(options.silent);
    const append = Boolean(options.append);
    const offset = Math.max(0, Number(options.offset || 0));
    const limit = Math.min(200, Math.max(1, Number(options.limit || 100)));
    if (!silent && !append) setLoading(true);
    if (append) setOrdersLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (status && status !== "all") params.set("status", status);
      if (options.from) params.set("from", options.from);
      if (options.to) params.set("to", options.to);
      params.set("offset", String(offset));
      params.set("limit", String(limit));
      const res = await fetch("/api/admin/orders?" + params.toString(), { credentials: "same-origin" });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const data = await res.json();
      if (data.ok) {
        setOrders((prev) => (append ? [...prev, ...(data.orders || [])] : (data.orders || [])));
        setOrdersMeta({ filteredCount: Number(data.filteredCount || 0), total: Number(data.total || 0), hasMore: Boolean(data.hasMore) });
        if (data.currentStaff) applyCurrentStaff(data.currentStaff);
        setAuthed(true);
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent && !append) setLoading(false);
      if (append) setOrdersLoadingMore(false);
    }
  }, [applyCurrentStaff]);

  useEffect(() => {
    if (authed === true && tab !== "orders" && tab !== "abnormal") return;
    loadOrders(appliedSearch, tab === "abnormal" ? "abnormal" : filterStatus, { from: dateFrom, to: dateTo });
  }, [authed, loadOrders, appliedSearch, filterStatus, tab, dateFrom, dateTo]);

  useEffect(() => {
    if (!authed || (tab !== "orders" && tab !== "abnormal")) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (activeOrder) return;
      // 原位刷新当前已加载的条数(限 200),让新订单出现而不丢失已翻页内容
      loadOrders(appliedSearch, tab === "abnormal" ? "abnormal" : filterStatus, { silent: true, offset: 0, limit: Math.min(200, Math.max(100, orders.length)), from: dateFrom, to: dateTo });
    }, 10000);
    return () => clearInterval(timer);
  }, [authed, tab, activeOrder, loadOrders, appliedSearch, filterStatus, dateFrom, dateTo, orders.length]);

  useEffect(() => {
    const orderId = String(activeOrder?.orderId || "").trim();
    if (!authed || !orderId) return;
    let disposed = false;
    let busy = false;
    let knownRevision = customerDetailsRevision(activeOrder);

    const refreshCustomerDetails = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        const data = await response.json();
        if (disposed || !response.ok || !data.ok || !data.order) return;
        const latest = data.order;
        const revision = customerDetailsRevision(latest);
        if (revision === knownRevision) return;
        knownRevision = revision;
        setActiveOrder((current) => current?.orderId === orderId ? latest : current);
        setOrders((current) => current.map((order) => order.orderId === orderId ? latest : order));
        setEditForm((current) => {
          if (!current) return current;
          return {
            ...current,
            items: current.items.map((draft, index) => {
              const item = latest.items?.[index];
              if (!item) return draft;
              return {
                ...draft,
                account: item.account || "",
                password: item.password || "",
                passwordCorrectionRequestedAt: item.passwordCorrectionRequestedAt || "",
                passwordCorrectionRequestedAtBeijing: item.passwordCorrectionRequestedAtBeijing || "",
                passwordCorrectionEmailSentAtBeijing: item.passwordCorrectionEmailSentAtBeijing || "",
                passwordCorrectionEmailOk: Boolean(item.passwordCorrectionEmailOk),
                passwordCorrectionStaffNote: item.passwordCorrectionStaffNote || "",
                customerPasswordUpdatedAt: item.customerPasswordUpdatedAt || "",
                customerPasswordUpdatedAtBeijing: item.customerPasswordUpdatedAtBeijing || "",
                customerPasswordUpdateCount: Number(item.customerPasswordUpdateCount || 0),
              };
            }),
          };
        });
      } catch (error) {
        // Keep the current editor usable if a background refresh fails.
      } finally {
        busy = false;
      }
    };

    refreshCustomerDetails();
    const timer = setInterval(refreshCustomerDetails, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [authed, activeOrder?.orderId]);

  function downloadOrdersCsv() {
    const params = new URLSearchParams();
    if (appliedSearch) params.set("q", appliedSearch);
    const status = tab === "abnormal" ? "abnormal" : filterStatus;
    if (status && status !== "all") params.set("status", status);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    params.set("format", "csv");
    const a = document.createElement("a");
    a.href = "/api/admin/orders?" + params.toString();
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // 通用客户端 CSV 导出(按当前已加载/筛选的数据)
  function csvDownload(filename, headers, rows) {
    const cell = (v) => { const s = String(v == null ? "" : v).replace(/\r?\n/g, " "); return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = "﻿" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  function csvStamp() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
  function exportUsersCsv() {
    const rows = (allUsers.users || []).map((u) => [u.email, u.username, Number(u.balance || 0).toFixed(2), u.banned ? "已封禁" : "正常", u.createdAtBeijing || "", u.referral?.invitedByEmail || "", Number(u.referral?.levelOneCount || 0), Number(u.referral?.levelTwoCount || 0)]);
    csvDownload(`users-${csvStamp()}.csv`, ["邮箱", "用户名", "余额", "状态", "注册时间", "上级", "一级下级数", "二级下级数"], rows);
  }
  function exportBalanceCsv() {
    const rows = (globalLog.entries || []).map((t) => [t.createdAtBeijing || "", t.email || "", Number(t.amount || 0).toFixed(2), t.reason || "", Number(t.balanceAfter || 0).toFixed(2), t.staffId || ""]);
    csvDownload(`balance-${csvStamp()}.csv`, ["时间", "邮箱", "变动", "原因", "变动后余额", "操作员"], rows);
  }
  function exportWithdrawalsCsv() {
    const rows = (withdrawals || []).map((w) => [w.createdAtBeijing || "", w.userEmail || "", Number(w.amount || 0).toFixed(2), w.statusLabel || w.status || "", w.alipayAccount || "", w.realName || "", w.updatedByStaffId || ""]);
    csvDownload(`withdrawals-${csvStamp()}.csv`, ["申请时间", "邮箱", "金额", "状态", "支付宝", "姓名", "操作员"], rows);
  }

  useEffect(() => {
    if (!authed || tab !== "orders" || !newOrderAlert?.orderId) return;
    setSearchInput("");
    setAppliedSearch("");
    setFilterStatus("all");
    loadOrders("", "all", { silent: true });
  }, [authed, tab, newOrderAlert?.orderId, loadOrders]);

  // 移动端导航抽屉的无障碍管理:仅在抽屉断点(≤900px)生效——
  // 打开时把焦点移入侧栏、Tab 困在抽屉内、背景设为 inert(屏蔽读屏/抓焦点)、Esc 关闭;关闭时焦点归还汉堡按钮。
  useEffect(() => {
    if (!navOpen || typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 900px)").matches) return; // 桌面侧栏常驻,无需抽屉焦点管理
    const sidebar = document.querySelector(".admin-sidebar");
    const toggle = document.querySelector(".admin-nav-toggle");
    const content = document.querySelector(".admin-content");
    const focusables = sidebar ? Array.from(sidebar.querySelectorAll("button:not([disabled])")) : [];
    if (content) { content.setAttribute("inert", ""); content.setAttribute("aria-hidden", "true"); }
    if (focusables.length) focusables[0].focus();
    function onKey(e) {
      if (e.key === "Escape") { setNavOpen(false); return; }
      if (e.key === "Tab" && focusables.length) {
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (content) { content.removeAttribute("inert"); content.removeAttribute("aria-hidden"); }
      if (toggle && typeof toggle.focus === "function") toggle.focus();
    };
  }, [navOpen]);

  function openNewOrderNotice() {
    setTab("orders");
    setSearchInput("");
    setAppliedSearch("");
    setFilterStatus("all");
    setNewOrderAlert(null);
    loadOrders("", "all", { silent: true });
    loadOverview({ silent: true });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openOverviewTarget(target) {
    if (target === "awaiting_quote" || target === "pending_payment" || target === "quote_expired") {
      setTab("orders");
      setSearchInput("");
      setAppliedSearch("");
      setFilterStatus(target);
      loadOrders("", target, { silent: true });
      return;
    }
    if (target === "orders") {
      setTab("orders");
      setSearchInput("");
      setAppliedSearch("");
      setFilterStatus("received");
      loadOrders("", "received", { silent: true });
      return;
    }
    if (target === "abnormal") {
      setTab("abnormal");
      setSearchInput("");
      setAppliedSearch("");
      loadOrders("", "abnormal", { silent: true });
      return;
    }
    if (target === "withdrawals") {
      if (!canReviewWithdrawals) return;
      setTab("withdrawals");
      return;
    }
    if (target === "codes") {
      if (!canViewCodes) return;
      setTab("codes");
      return;
    }
    if (target === "mail") {
      if (!canSendMail) return;
      setTab("mail");
      return;
    }
    if (target === "users") {
      if (!canViewUsers) return;
      setTab("users");
    }
  }

  // 总览「即将到期」芯片 → 跳到订单列表并定位该单
  function openExpiringOrder(orderId) {
    const id = String(orderId || "").trim();
    if (!id) return;
    setTab("orders");
    setSearchInput(id);
    setAppliedSearch(id);
    setFilterStatus("all");
    loadOrders(id, "all", { silent: true });
  }

  async function doLogin(e) {
    e.preventDefault();
    if (loggingIn) return;
    setLoggingIn(true);
    setLoginError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginName, password, otp: loginOtp || undefined }),
      });
      const data = await res.json();
      if (data.ok) {
        setAuthed(true);
        setCurrentStaff(data.staff || null);
        setPassword("");
        setLoginOtp("");
        setLoginNeed2fa(false);
        loadOrders(appliedSearch, filterStatus);
      } else if (data.need2fa) {
        setLoginNeed2fa(true);
        setLoginError(data.error === "invalid_2fa" ? "动态码错误,请重试(也可输入备用恢复码)" : "");
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
    setCurrentStaff(null);
    setOrders([]);
    overviewRef.current = null;
    setOverview(null);
    setNewOrderAlert(null);
  }

  function openOrder(order) {
    setHighlightOrderIds((current) => {
      if (!current.has(order.orderId)) return current;
      const next = new Set(current);
      next.delete(order.orderId);
      return next;
    });
    setActiveOrder(order);
    setEditForm({
      status: order.status,
      quoteAmount: order.quoteAmount ? String(order.quoteAmount) : "",
      quoteValidDays: String(order.quoteValidDays || 7),
      staffNotes: order.staffNotes || "",
      items: order.items.map((it) => ({
        index: order.items.indexOf(it),
        service: it.service,
        label: it.label,
        account: it.account || "",
        password: it.password || "",
        staffAccount: it.staffAccount || "",
        staffPassword: it.staffPassword || "",
        passwordCorrectionRequestedAt: it.passwordCorrectionRequestedAt || "",
        passwordCorrectionRequestedAtBeijing: it.passwordCorrectionRequestedAtBeijing || "",
        passwordCorrectionEmailSentAtBeijing: it.passwordCorrectionEmailSentAtBeijing || "",
        passwordCorrectionEmailOk: Boolean(it.passwordCorrectionEmailOk),
        passwordCorrectionStaffNote: it.passwordCorrectionStaffNote || "",
        customerPasswordUpdatedAt: it.customerPasswordUpdatedAt || "",
        customerPasswordUpdatedAtBeijing: it.customerPasswordUpdatedAtBeijing || "",
        customerPasswordUpdateCount: Number(it.customerPasswordUpdateCount || 0),
      })),
    });
    setSaveResult(null);
    setConfirmDelete(false);
    setSpotifyPasswordMail(null);
  }

  async function openRelatedOrder(orderId) {
    const normalizedId = String(orderId || "").trim().toUpperCase();
    if (!normalizedId) throw new Error("order_not_found");
    const params = new URLSearchParams({ q: normalizedId, offset: "0", limit: "20" });
    const response = await fetch(`/api/admin/orders?${params.toString()}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "order_load_failed");
    const order = (data.orders || []).find((item) => String(item.orderId || "").toUpperCase() === normalizedId);
    if (!order) throw new Error("order_not_found");
    openOrder(order);
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
    if (action === "delete" && !isRootStaff) {
      setBatchResult({ type: "error", message: "仅主账号可删除订单" });
      setBatchConfirm(null);
      return;
    }
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
        loadOverview({ silent: true });
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
    if (!isRootStaff) {
      setSaveResult({ type: "error", message: "仅主账号可删除订单" });
      setConfirmDelete(false);
      return;
    }
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
        loadOverview({ silent: true });
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

  async function sendSpotifyPasswordError(itemPosition) {
    if (!activeOrder || !editForm || spotifyPasswordMailBusy) return;
    const item = editForm.items[itemPosition];
    if (!item || item.service !== "spotify") return;
    setSpotifyPasswordMailBusy(true);
    setSaveResult(null);
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(activeOrder.orderId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "spotify_password_error",
          itemIndex: item.index,
          staffNote: spotifyPasswordMail?.index === itemPosition ? spotifyPasswordMail.note : "",
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const message = {
          spotify_item_not_found: "未找到对应的 Spotify 商品",
          order_email_missing: "订单邮箱无效，无法发送邮件",
          order_invalid: "无效订单不能发送密码更正邮件",
        }[data.error] || data.error || "发送失败";
        throw new Error(message);
      }
      const returnedItem = data.order?.items?.[item.index] || {};
      setActiveOrder(data.order);
      setEditForm((current) => ({
        ...current,
        items: current.items.map((currentItem, index) => index === itemPosition ? { ...currentItem, ...returnedItem, index: currentItem.index } : currentItem),
      }));
      if (data.passwordCorrection?.email?.ok) {
        setSaveResult({ type: "success", message: "密码更新邮件已发送" });
        setSpotifyPasswordMail(null);
      } else {
        setSaveResult({ type: "error", message: "更新链接已生成，但邮件发送失败，请检查发信服务后重试" });
      }
      loadOrders(appliedSearch, filterStatus);
    } catch (sendError) {
      setSaveResult({ type: "error", message: sendError.message || "网络错误" });
    } finally {
      setSpotifyPasswordMailBusy(false);
    }
  }

  async function saveOrder() {
    if (!activeOrder || saving) return;
    // 作废二次确认(作废会自动退款/退券/恢复兑换码)
    if (editForm.status === "invalid" && activeOrder.status !== "invalid") {
      const willRefund = activeOrder.paidByBalance || activeOrder.couponId;
      const msg = willRefund
        ? `确认作废订单 ${activeOrder.orderId}？\n将自动退回余额/优惠券，并回收已发返佣。\n(兑换码已兑换即失效，不返还)`
        : `确认作废订单 ${activeOrder.orderId}？${activeOrder.paymentMethod === "redeem" ? "\n(兑换码已兑换即失效，不返还)" : ""}`;
      if (typeof window !== "undefined" && !window.confirm(msg)) return;
    }
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
        const completionMessage = data.completion?.email?.ok ? " · 完成邮件已发送" : data.completion ? " · 完成邮件发送失败" : "";
        const invalidMessage = data.invalidNotice?.email?.ok ? " · 无效通知已发送" : data.invalidNotice ? " · 无效通知发送失败" : "";
        setSaveResult({ type: "success", message: "已保存" + completionMessage + invalidMessage });
        loadOrders(appliedSearch, filterStatus);
        loadOverview({ silent: true });
        setActiveOrder(data.order);
      } else {
        const message = {
          quote_required: "请先填写报价并发送付款邮件",
          payment_not_received: "订单尚未收到付款，不能直接标记完成",
          invalid_status: "当前状态不可用",
        }[data.error] || data.error || "保存失败";
        setSaveResult({ type: "error", message });
      }
    } catch (e) {
      setSaveResult({ type: "error", message: "网络错误" });
    } finally {
      setSaving(false);
    }
  }

  async function sendProxyQuote() {
    if (!activeOrder || activeOrder.orderType !== "proxy_payment" || saving) return;
    const amount = Math.round(Number(editForm.quoteAmount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      setSaveResult({ type: "error", message: "请填写有效的报价金额" });
      return;
    }
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch(`/api/admin/orders/${encodeURIComponent(activeOrder.orderId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          quoteAmount: amount,
          quoteValidDays: Number(editForm.quoteValidDays || 7),
          staffNotes: editForm.staffNotes,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const message = {
          invalid_quote_amount: "报价金额无效",
          quote_status_locked: "当前订单状态不能重新报价",
        }[data.error] || data.error || "报价发送失败";
        throw new Error(message);
      }
      const mailText = data.quote?.email?.ok ? "报价邮件已发送" : "报价已保存，但邮件发送失败，请检查邮件配置后重新发送";
      setSaveResult({ type: data.quote?.email?.ok ? "success" : "error", message: mailText });
      setActiveOrder(data.order);
      setEditForm((current) => ({
        ...current,
        status: "pending_payment",
        quoteAmount: String(data.quote?.amount || amount),
        quoteValidDays: String(data.quote?.validDays || current.quoteValidDays || 7),
      }));
      loadOrders(appliedSearch, filterStatus);
      loadOverview({ silent: true });
    } catch (error) {
      setSaveResult({ type: "error", message: error.message || "网络错误" });
    } finally {
      setSaving(false);
    }
  }

  function openPdfRemarkModal(type, record) {
    setPdfExportModal({ type, record, note: "" });
  }

  function submitPdfExport(event) {
    event.preventDefault();
    if (!pdfExportModal?.record) return;
    const note = String(pdfExportModal.note || "").trim();
    if (pdfExportModal.type === "order") {
      exportOrderPdf(pdfExportModal.record, note);
    } else {
      exportRedeemHistoryPdf(pdfExportModal.record, note);
    }
    setPdfExportModal(null);
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
          <form onSubmit={doLogin} autoComplete="off">
            <input
              type="text"
              name="lm-admin-account"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              placeholder="工作人员账号"
              autoComplete="off"
              autoFocus
              required
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="管理员密码"
              required
            />
            {loginNeed2fa && (
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={loginOtp}
                onChange={(e) => setLoginOtp(e.target.value.replace(/[^0-9A-Za-z]/g, "").slice(0, 12))}
                placeholder="两步验证动态码(或备用恢复码)"
                autoFocus
                required
              />
            )}
            <button type="submit" disabled={loggingIn || !password || (loginNeed2fa && !loginOtp)}>
              {loggingIn ? <><LoaderCircle size={14} className="spin-icon" />登录中</> : (loginNeed2fa ? "验证并登录" : "登录")}
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
  if (authed === true && !permissionsReady) {
    return <div className="admin-loading"><LoaderCircle size={28} className="spin-icon" /></div>;
  }

  const mailSearchText = mailSearch.trim().toLowerCase();
  const isMarketingMailLog = (item) =>
    item?.template === MARKETING_MAIL_TEMPLATE_ID ||
    item?.category === "marketing" ||
    String(item?.subject || "").includes(MARKETING_MAIL_SUBJECT) ||
    String(item?.subject || "").includes("常用会员服务") ||
    String(item?.subject || "").includes("数字会员服务台") ||
    String(item?.content || item?.preview || "").includes(MARKETING_MAIL_PREVIEW) ||
    String(item?.content || item?.preview || "").includes("Spotify、Netflix") ||
    String(item?.content || item?.preview || "").includes("4K 影音");
  const customerMailLogs = mailLogs.filter((item) => !isMarketingMailLog(item));
  const marketingMailLogs = mailLogs.filter((item) => isMarketingMailLog(item));
  const scopedMailLogs = mailLogType === "marketing" ? marketingMailLogs : customerMailLogs;
  const visibleMailLogs = mailSearchText
    ? scopedMailLogs.filter((item) => String(item.to || "").toLowerCase().includes(mailSearchText))
    : scopedMailLogs;
  const staffActionCounts = new Map();
  staffPane.actions.forEach((item) => {
    const id = Number(item.staffId || 1);
    staffActionCounts.set(id, (staffActionCounts.get(id) || 0) + 1);
  });
  // 操作日志搜索(动作/对象/操作人/详情;导出 CSV 用同一份过滤结果)
  const actionQ = actionSearch.trim().toLowerCase();
  const filteredStaffActions = actionQ
    ? staffPane.actions.filter((a) =>
        [a.action, a.target, a.staffUsername, JSON.stringify(a.detail || {})].join(" ").toLowerCase().includes(actionQ))
    : staffPane.actions;
  const activeStaffActionIds = (activeStaffAction?.actions || []).map((item) => item.id).filter(Boolean);
  const activeStaffSelectedCount = activeStaffActionIds.filter((id) => selectedActionIds.has(id)).length;
  const activeStaffAllSelected = activeStaffActionIds.length > 0 && activeStaffSelectedCount === activeStaffActionIds.length;

  // 分组侧边导航模型 —— key/权限门控/角标与旧横向标签条逐项一致,仅改呈现不改功能
  const navGroups = [
    {
      title: "概览",
      items: [
        { key: "overview", label: "状态总览", icon: LayoutDashboard, show: true },
      ],
    },
    {
      title: "交易",
      items: [
        { key: "orders", label: "订单管理", icon: ClipboardList, show: true, badge: Number(overview?.pendingOrders || 0) },
        { key: "after-sales", label: "售后工单", icon: LifeBuoy, show: true, badge: Number(overview?.pendingAfterSales || 0), warn: true },
        { key: "abnormal", label: "异常订单", icon: AlertTriangle, show: true, badge: Number(overview?.abnormalOrders || 0), warn: true },
        { key: "abandoned", label: "弃单召回", icon: ShoppingCart, show: isRootStaff, badge: Number(overview?.abandonedTotal || 0) },
      ],
    },
    {
      title: "客户",
      items: [
        { key: "users", label: "用户管理", icon: Users, show: canViewUsers },
        { key: "withdrawals", label: "提现审核", icon: Wallet, show: canReviewWithdrawals, badge: Number(overview?.pendingWithdrawals || 0) },
        { key: "balance", label: "余额变动", icon: Coins, show: canViewBalanceLog },
      ],
    },
    {
      title: "营销",
      items: [
        { key: "catalog", label: "商品价格", icon: Package, show: isRootStaff },
        { key: "codes", label: "兑换码", icon: Gift, show: canViewCodes },
        { key: "mail", label: "客服发信", icon: Mail, show: canSendMail },
        { key: "mail-delivery", label: "邮件投递", icon: MailCheck, show: isRootStaff },
        { key: "announce", label: "站内公告", icon: Megaphone, show: isRootStaff },
        { key: "announce-posts", label: "公告中心", icon: Newspaper, show: isRootStaff },
      ],
    },
    {
      title: "数据",
      items: [
        { key: "insights", label: "数据洞察", icon: BarChart3, show: isRootStaff },
        { key: "visitors", label: "历史访客", icon: Footprints, show: isRootStaff },
      ],
    },
    {
      title: "系统",
      items: [
        { key: "health", label: "系统健康", icon: Activity, show: isRootStaff },
        { key: "settings", label: "站点设置", icon: SlidersHorizontal, show: isRootStaff },
        { key: "ai-quota", label: "AI 限额", icon: Gauge, show: isRootStaff },
        { key: "staff", label: "工作人员", icon: ShieldCheck, show: isRootStaff },
        { key: "security", label: "安全中心", icon: ShieldCheck, show: true },
      ],
    },
  ];

  // ── Dashboard ──
  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-left">
          <button
            type="button"
            className="admin-nav-toggle"
            aria-label="切换导航菜单"
            aria-expanded={navOpen}
            aria-controls="admin-sidebar-nav"
            onClick={() => setNavOpen((v) => !v)}
          >
            <Menu size={18} />
          </button>
          <Link href="/"><img src="/logo.png" alt="冒央会社" className="admin-logo" /></Link>
          <span className="admin-tag">工作后台{currentStaff?.id ? ` · #${currentStaff.id}` : ""}</span>
        </div>
        <button type="button" className="admin-logout" onClick={doLogout}>
          <LogOut size={14} />退出
        </button>
      </header>

      <main className="admin-main">
        <div className={`admin-shell${navOpen ? " nav-open" : ""}`}>
          <button type="button" className="admin-nav-scrim" aria-label="关闭菜单" onClick={() => setNavOpen(false)} />
          <nav className="admin-sidebar" id="admin-sidebar-nav" aria-label="后台导航">
            {navGroups.map((group) => {
              const items = group.items.filter((it) => it.show);
              if (!items.length) return null;
              return (
                <div className="admin-nav-group" key={group.title}>
                  <div className="admin-nav-group-title">{group.title}</div>
                  {items.map((it) => {
                    const Icon = it.icon;
                    return (
                      <button
                        key={it.key}
                        type="button"
                        className={`admin-nav-item${tab === it.key ? " active" : ""}`}
                        aria-current={tab === it.key ? "page" : undefined}
                        onClick={() => { setTab(it.key); setNavOpen(false); }}
                      >
                        <Icon size={16} className="admin-nav-icon" />
                        <span className="admin-nav-label">{it.label}</span>
                        {Number(it.badge) > 0 && (
                          <em className={`admin-tab-badge${it.warn ? " warn" : ""}`}>{it.badge}</em>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>

          <div className="admin-content">

        <button type="button" className="admin-global-search-trigger" onClick={() => setSearchOpen(true)}>
          <Search size={14} /><span>搜索订单 / 用户 / 兑换码…</span><kbd>⌘K</kbd>
        </button>

        {newOrderAlert && (
          <button type="button" className="admin-new-order-alert" onClick={openNewOrderNotice}>
            <BellRing size={14} />
            <b>新订单 +{newOrderAlert.count}</b>
            <span>{newOrderAlert.service || "点击查看最新订单"}</span>
          </button>
        )}

        {tab === "overview" ? (
          <div className="admin-overview-page">
            <div className="admin-overview-card">
              <div className="admin-overview-head">
                <span><BarChart3 size={13} />状态总览</span>
                {usdtCheckMsg && <em className="admin-overview-toast">{usdtCheckMsg}</em>}
                {overviewLoading && <LoaderCircle size={12} className="spin-icon" />}
              </div>
              <button type="button" className="admin-overview-item urgent" onClick={() => openOverviewTarget("orders")}>
                <span>待处理订单</span>
                <b>{overview?.receivedOrders ?? 0}</b>
              </button>
              <button type="button" className="admin-overview-item urgent" onClick={() => openOverviewTarget("awaiting_quote")}>
                <span>代付待报价</span>
                <b>{overview?.awaitingQuotes ?? 0}</b>
              </button>
              <button type="button" className="admin-overview-item" onClick={() => openOverviewTarget("pending_payment")}>
                <span>代付待付款</span>
                <b>{overview?.pendingQuotePayments ?? 0}</b>
              </button>
              <button type="button" className="admin-overview-item warn" onClick={() => openOverviewTarget("abnormal")}>
                <span>异常订单</span>
                <b>{overview?.abnormalOrders ?? 0}</b>
              </button>
              {overview?.usdtAutoConfirm && (
                <button type="button" className="admin-overview-item" onClick={() => runUsdtCheck(true)} title="立即检查 TRON 链上到账">
                  <span>USDT 待确认 {usdtChecking && <LoaderCircle size={11} className="spin-icon" />}</span>
                  <b>{overview?.usdtPendingConfirm ?? 0}</b>
                </button>
              )}
              {canReviewWithdrawals && (
                <button type="button" className="admin-overview-item" onClick={() => openOverviewTarget("withdrawals")}>
                  <span>待审核提现</span>
                  <b>{overview?.pendingWithdrawals ?? 0}</b>
                </button>
              )}
              {canViewCodes && (
                <button type="button" className="admin-overview-item" onClick={() => openOverviewTarget("codes")}>
                  <span>可用兑换码</span>
                  <b>{overview?.activeCodes ?? 0}</b>
                </button>
              )}
              {canSendMail && (
                <button type="button" className="admin-overview-item" onClick={() => openOverviewTarget("mail")}>
                  <span>失败邮件</span>
                  <b>{overview?.failedMails ?? 0}</b>
                </button>
              )}
              {canViewUsers && (
                <button type="button" className="admin-overview-item" onClick={() => openOverviewTarget("users")}>
                  <span>注册用户</span>
                  <b>{overview?.usersTotal ?? 0}</b>
                </button>
              )}
              <div className="admin-overview-mini">
                <span>今日订单 <DeltaBadge cur={overview?.todayOrders} prev={overview?.yesterdayOrders} /></span>
                <b>{overview?.todayOrders ?? 0}</b>
              </div>
              <div className="admin-overview-mini money">
                <span>今日营收 <DeltaBadge cur={overview?.todayRevenue} prev={overview?.yesterdayRevenue} /></span>
                <b>¥{Number(overview?.todayRevenue || 0).toFixed(2)}</b>
              </div>
              <div className="admin-overview-mini">
                <span>累计订单</span>
                <b>{overview?.ordersTotal ?? 0}</b>
              </div>
              <div className="admin-overview-mini money">
                <span>累计营收</span>
                <b>¥{Number(overview?.totalRevenue || 0).toFixed(2)}</b>
              </div>
            </div>

            <div className="admin-overview-revenue">
              <div className="admin-overview-revenue-item">
                <span>近 7 天营收</span>
                <b>¥{Number(overview?.revenue7d || 0).toFixed(2)}</b>
              </div>
              <div className="admin-overview-revenue-item">
                <span>近 30 天营收</span>
                <b>¥{Number(overview?.revenue30d || 0).toFixed(2)}</b>
              </div>
              <div className="admin-overview-revenue-item">
                <span>本月营收</span>
                <b>¥{Number(overview?.revenueMonth || 0).toFixed(2)}</b>
              </div>
              <div className="admin-overview-revenue-item">
                <span>客单价 · 成交 {overview?.paidOrders ?? 0} 单</span>
                <b>¥{Number(overview?.avgOrderValue || 0).toFixed(2)}</b>
              </div>
            </div>

            {Array.isArray(overview?.expiringSoon) && overview.expiringSoon.length > 0 && (
              <div className="admin-overview-lowstock admin-overview-expiring">
                <div className="admin-overview-trend-head">
                  <Clock size={13} />即将到期
                  <small>已完成订单 7 天内到期({overview.expiringSoonTotal ?? overview.expiringSoon.length} 单),点击跟进续费</small>
                </div>
                <div className="admin-overview-lowstock-chips">
                  {overview.expiringSoon.map((it) => (
                    <button
                      key={it.orderId}
                      type="button"
                      className={`admin-lowstock-chip${it.daysLeft < 0 ? " out" : ""}`}
                      onClick={() => openExpiringOrder(it.orderId)}
                      title={`${it.orderId} · ${it.email}`}
                    >
                      {it.serviceLabel || it.orderId}
                      {it.reminded ? <em className="admin-expiring-reminded">已提醒</em> : null}
                      <b>{it.daysLeft < 0 ? "已到期" : it.daysLeft === 0 ? "今天" : `剩 ${it.daysLeft} 天`}</b>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {Array.isArray(overview?.trend) && overview.trend.length > 1 && (
              <div className="admin-overview-trends">
                <OverviewTrendCard
                  title="近 14 天订单"
                  rows={overview.trend}
                  valueKey="orders"
                  color="#0f766e"
                  fill="rgba(15, 118, 110, 0.12)"
                  suffix="单"
                />
                <OverviewTrendCard
                  title="近 14 天营收"
                  rows={overview.trend}
                  valueKey="revenue"
                  color="#b45309"
                  fill="rgba(180, 83, 9, 0.11)"
                  money
                />
              </div>
            )}
          </div>
        ) : tab === "after-sales" ? (
          <AfterSalesPanel
            canEdit={canEditOrders}
            onChanged={() => loadOverview({ silent: true })}
            onOpenOrder={openRelatedOrder}
          />
        ) : tab === "users" ? (
          <div className="admin-users-pane">
            {/* All registered users */}
            <div className="admin-userlist">
              <div className="admin-userlist-head">
                <h3>全部注册用户 <em>{allUsers.total}</em></h3>
                {allUsers.users.length > 0 && (
                  <button type="button" className="admin-csv-btn" onClick={exportUsersCsv} title="导出当前用户列表 CSV"><Download size={13} />导出CSV</button>
                )}
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
                  <div key={u.email} className={`admin-userlist-item${u.banned ? " banned" : ""}`}>
                    <button
                      type="button"
                      className="admin-userlist-main"
                      onClick={() => loadUser(u.email)}
                    >
                      <span className="admin-userlist-name">
                        <span className="admin-userlist-name-text">{u.username || "—"}</span>
                        {u.banned && <em className="admin-userlist-banned">已封禁</em>}
                        {Number(u.referral?.levelOneCount || 0) > 0 && (
                          <em className="admin-userlist-ref-chip down" title="一级下级人数">下级 {Number(u.referral.levelOneCount)}</em>
                        )}
                        {Number(u.referral?.levelTwoCount || 0) > 0 && (
                          <em className="admin-userlist-ref-chip down2" title="二级下级人数">二级 {Number(u.referral.levelTwoCount)}</em>
                        )}
                        {u.referral?.invitedByEmail && (
                          <em className="admin-userlist-ref-chip up" title={`上级 ${u.referral.invitedByEmail}`}>上级</em>
                        )}
                      </span>
                      <span className="admin-userlist-email">{u.email}</span>
                      <span className="admin-userlist-balance">¥{u.balance.toFixed(2)}</span>
                    </button>
                    <div className="admin-userlist-actions">
                      {canBanUsers && (
                        <button
                          type="button"
                          className="admin-userlist-action ban"
                          title={u.banned ? "解除封禁" : "封禁账户"}
                          onClick={() => setConfirmUserAction({ email: u.email, action: u.banned ? "unban" : "ban" })}
                        >{u.banned ? "解禁" : "封禁"}</button>
                      )}
                      {canDeleteUsers && (
                        <button
                          type="button"
                          className="admin-userlist-action delete"
                          title="删除账户"
                          onClick={() => setConfirmUserAction({ email: u.email, action: "delete" })}
                        ><Trash2 size={11} /></button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {userError && <div className="admin-alert error" style={{ marginTop: 8 }}>{userError}</div>}

            {false && userInfo && (
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

          </div>
        ) : tab === "withdrawals" ? (
          <div className="admin-withdraw-pane single">
            <div className="admin-withdraw-list">
              <div className="admin-userlist-head">
                <h3>提现申请 <em>{withdrawals.length}</em></h3>
                <div className="admin-inline-actions">
                  {withdrawals.length > 0 && (
                    <button type="button" className="admin-csv-btn" onClick={exportWithdrawalsCsv} title="导出提现申请 CSV"><Download size={13} />导出CSV</button>
                  )}
                  {canDeleteRecords && (
                    <>
                      <button
                        type="button"
                        className={`admin-filter-btn${withdrawalBatchMode ? " active" : ""}`}
                        onClick={() => {
                          setWithdrawalBatchMode((value) => !value);
                          setSelectedWithdrawalIds(new Set());
                          setWithdrawalDeleteResult(null);
                        }}
                      >{withdrawalBatchMode ? "取消" : "批量"}</button>
                      {withdrawalBatchMode && (
                        <>
                          <button type="button" className="admin-filter-btn" onClick={() => setSelectedWithdrawalIds(new Set(withdrawals.map((w) => w.id)))}>全选</button>
                          <button type="button" className="admin-filter-btn danger" onClick={deleteSelectedWithdrawals} disabled={withdrawalDeleteBusy || selectedWithdrawalIds.size === 0}>
                            {withdrawalDeleteBusy ? "删除中" : `删除 ${selectedWithdrawalIds.size}`}
                          </button>
                        </>
                      )}
                    </>
                  )}
                  <button type="button" className="admin-filter-btn" onClick={loadWithdrawals} disabled={withdrawalLoading}>
                    {withdrawalLoading ? "刷新中" : "刷新"}
                  </button>
                </div>
              </div>
              {withdrawalDeleteResult && <div className={`admin-alert ${withdrawalDeleteResult.type}`}>{withdrawalDeleteResult.message}</div>}
              <div className="admin-userlist-body">
                {withdrawals.length === 0 ? (
                  <div className="admin-userlist-empty">{withdrawalLoading ? "加载中..." : "暂无提现申请"}</div>
                ) : withdrawals.map((w) => {
                  const selected = selectedWithdrawalIds.has(w.id);
                  return (
                  <button
                    key={w.id}
                    type="button"
                    className={`admin-withdraw-item status-${w.status}${withdrawalBatchMode ? " batch-mode" : ""}${selected ? " selected" : ""}`}
                    data-staff-id={w.updatedByStaffId ? String(w.updatedByStaffId) : ""}
                    onClick={() => withdrawalBatchMode ? toggleWithdrawalSelect(w.id) : openWithdrawal(w.id)}
                  >
                    {withdrawalBatchMode && (
                      <span className={`admin-order-checkbox${selected ? " checked" : ""}`} aria-hidden="true">
                        {selected && <CheckCircle2 size={13} />}
                      </span>
                    )}
                    <span>
                      <strong>{w.username || "未设置用户名"}</strong>
                      <small>{w.userEmail}</small>
                    </span>
                    <span>
                      <b>¥{Number(w.amount || 0).toFixed(2)}</b>
                      <em>{w.statusLabel || "待审核"}</em>
                    </span>
                  </button>
                  );
                })}
              </div>
            </div>

            <div className="admin-withdraw-detail" style={{ display: "none" }}>
              {!activeWithdrawal ? (
                <div className="admin-userlist-empty">点击提现申请查看支付宝、姓名与该用户所有余额明细</div>
              ) : (
                <>
                  <div className="admin-withdraw-info-grid">
                    <div><span>用户名</span><b>{activeWithdrawal.withdrawal.username || "未设置"}</b></div>
                    <div><span>邮箱</span><b>{activeWithdrawal.withdrawal.userEmail}</b></div>
                    <div><span>提现金额</span><b>¥{Number(activeWithdrawal.withdrawal.amount || 0).toFixed(2)}</b></div>
                    <div><span>当前余额</span><b>¥{Number(activeWithdrawal.user?.balance || 0).toFixed(2)}</b></div>
                    <div><span>支付宝</span><b>{activeWithdrawal.withdrawal.alipayAccount}</b></div>
                    <div><span>姓名</span><b>{activeWithdrawal.withdrawal.realName}</b></div>
                  </div>
                  <form className="admin-withdraw-status-form" onSubmit={saveWithdrawalStatus}>
                    <label>
                      <span>状态</span>
                      <select value={withdrawalStatus} onChange={(e) => setWithdrawalStatus(e.target.value)}>
                        {WITHDRAWAL_STATUS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>备注</span>
                      <input value={withdrawalNote} onChange={(e) => setWithdrawalNote(e.target.value)} placeholder="可选,给工作人员内部记录" />
                    </label>
                    <button type="submit" disabled={withdrawalBusy}>
                      {withdrawalBusy ? <LoaderCircle size={12} className="spin-icon" /> : <CheckCircle2 size={12} />}
                      更新状态
                    </button>
                  </form>
                  <div className="admin-tx-list">
                    <div className="admin-tx-list-label">该用户余额明细 · {activeWithdrawal.transactions.length} 笔</div>
                    {activeWithdrawal.transactions.map((tx) => (
                      <div key={tx.id} className={`admin-tx-item${tx.amount > 0 ? " positive" : " negative"}`}>
                        <div className="admin-tx-item-info">
                          <strong>{tx.reason}</strong>
                          <small>{tx.createdAtBeijing}{tx.statusLabel ? ` · ${tx.statusLabel}` : ""}</small>
                        </div>
                        <div className="admin-tx-item-amount">{tx.amount > 0 ? "+" : ""}¥{Math.abs(tx.amount).toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : tab === "codes" ? (
          <div className="admin-codes-pane">
            {!canManageCodes && (
              <div className="admin-code-form admin-code-send-only">
                <div className="admin-card-title"><Mail size={15} />兑换码发信</div>
                <p>当前账号可查看可用兑换码，并将兑换码发送至用户邮箱。</p>
              </div>
            )}
            {canManageCodes && (
            <form
              className="admin-code-form"
              onSubmit={(e) => {
                if (codeType === "history") {
                  e.preventDefault();
                  loadRedeemHistory(redeemHistoryQuery);
                } else {
                  createCode(e);
                }
              }}
            >
              <div className="admin-card-title">
                {codeType === "history" ? <FileText size={15} /> : <Gift size={15} />}
                {codeType === "history" ? "兑换历史" : "生成兑换码"}
              </div>
              <div className="admin-code-type-toggle">
                <button type="button" className={codeType === "service" ? "active" : ""} onClick={() => setCodeType("service")}>服务码</button>
                <button type="button" className={codeType === "balance" ? "active" : ""} onClick={() => setCodeType("balance")}>余额码</button>
                <button type="button" className={codeType === "history" ? "active" : ""} onClick={() => { setCodeType("history"); loadRedeemHistory(redeemHistoryQuery); }}>兑换历史</button>
              </div>
              {codeType === "history" ? (
                <div className="admin-code-history-panel">
                  <div className="admin-code-history-search">
                    <Search size={13} />
                    <input
                      value={redeemHistoryQuery}
                      onChange={(e) => setRedeemHistoryQuery(e.target.value)}
                      placeholder="搜索兑换码 / 邮箱 / 订单号 / IP"
                      autoComplete="off"
                    />
                    <button type="submit" disabled={redeemHistoryLoading}>
                      {redeemHistoryLoading ? <LoaderCircle size={11} className="spin-icon" /> : "搜索"}
                    </button>
                  </div>
                  {canDeleteRecords && (
                    <div className="admin-inline-actions admin-code-history-actions">
                      <button
                        type="button"
                        className={`admin-filter-btn${redeemHistoryBatchMode ? " active" : ""}`}
                        onClick={() => {
                          setRedeemHistoryBatchMode((value) => !value);
                          setSelectedRedeemHistoryCodes(new Set());
                        }}
                      >
                        {redeemHistoryBatchMode ? "退出批量" : "批量删除"}
                      </button>
                      {redeemHistoryBatchMode && (
                        <>
                          <button type="button" className="admin-filter-btn" onClick={selectAllRedeemHistory} disabled={redeemHistory.length === 0}>全选</button>
                          <button type="button" className="admin-filter-btn" onClick={() => setSelectedRedeemHistoryCodes(new Set())} disabled={selectedRedeemHistoryCodes.size === 0}>清除</button>
                          <button type="button" className="admin-filter-btn danger" onClick={deleteSelectedRedeemHistory} disabled={redeemHistoryDeleteBusy || selectedRedeemHistoryCodes.size === 0}>
                            {redeemHistoryDeleteBusy ? "删除中" : `删除 ${selectedRedeemHistoryCodes.size}`}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  <div className="admin-code-history-list">
                    {redeemHistoryLoading ? (
                      <div className="admin-userlist-empty">加载中...</div>
                    ) : redeemHistory.length === 0 ? (
                      <div className="admin-userlist-empty">暂无兑换历史</div>
                    ) : redeemHistory.map((item) => {
                      const selected = selectedRedeemHistoryCodes.has(item.code);
                      return (
                        <button
                          key={item.code}
                          type="button"
                          className={`admin-code-history-item${redeemHistoryBatchMode ? " batch-mode" : ""}${selected ? " selected" : ""}`}
                          onClick={() => redeemHistoryBatchMode ? toggleRedeemHistorySelect(item.code) : setActiveRedeemHistory(item)}
                        >
                          {redeemHistoryBatchMode && (
                            <span className="admin-order-checkbox">
                              {selected && <CheckCircle2 size={11} />}
                            </span>
                          )}
                          <span>
                            <strong>{item.code}</strong>
                          </span>
                          <span>
                            <b>{item.usedBy || item.order?.email || "未记录邮箱"}</b>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <>
              <div className="admin-code-inline-fields">
                <label>
                  <span>数量</span>
                  <input
                    value={codeQuantity}
                    onChange={(e) => setCodeQuantity(e.target.value.replace(/\D/g, ""))}
                    placeholder="1"
                    inputMode="numeric"
                    disabled={Boolean(codeCustom.trim())}
                    required
                  />
                </label>
                <label>
                  <span>备注</span>
                  <input
                    value={codeRemark}
                    onChange={(e) => setCodeRemark(e.target.value)}
                    placeholder="批次备注，可选"
                    maxLength={80}
                  />
                </label>
              </div>
              <label className="admin-code-custom-field">
                <span>自定义代码</span>
                <input
                  value={codeCustom}
                  onChange={(e) => {
                    const next = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 40);
                    setCodeCustom(next);
                    if (next) setCodeQuantity("1");
                  }}
                  placeholder="可选,留空随机生成;填写后仅生成1个"
                  autoComplete="off"
                  maxLength={40}
                />
              </label>
              {codeType === "balance" ? (
                <input
                  value={codeAmount}
                  onChange={(e) => setCodeAmount(e.target.value)}
                  placeholder="输入兑换金额,例如 50 或 88.88"
                  inputMode="decimal"
                  required
                />
              ) : (
                <div className="admin-code-service-picker">
                  {PRODUCTS.filter((p) => !p.quoteOnly).flatMap((p) => {
                    if (hasProductPlans(p.key)) {
                      const selectedService = codeServices.find((s) => {
                        const sk = typeof s === "string" ? s : s.key;
                        return sk === p.key;
                      });
                      const selectedPlanId = selectedService && typeof selectedService !== "string" ? selectedService.plan : "";
                      const selectedPlan = selectedPlanId ? getProductPlan(p.key, selectedPlanId) : null;
                      return [(
                        <div
                          key={p.key}
                          className={`admin-code-service-combo${selectedPlan ? " selected" : ""}`}
                        >
                          <img src={p.image} alt="" />
                          <span>{p.title}</span>
                          <select
                            className="admin-code-service-native-select"
                            value={selectedPlanId}
                            onChange={(e) => setCodeServicePlan(p.key, e.target.value)}
                            aria-label={`选择${p.title}规格`}
                          >
                            <option value="">选择规格</option>
                            {getProductPlanOptions(p.key).map((plan) => (
                              <option key={plan.id} value={plan.id}>
                                {plan.label} ¥{plan.amount}/{plan.unit || "年"}
                              </option>
                            ))}
                          </select>
                        </div>
                      )];
                    }
                    const selected = codeServices.some((s) => (typeof s === "string" ? s : s.key) === p.key);
                    return [(
                      <button
                        key={p.key}
                        type="button"
                        className={selected ? "selected" : ""}
                        onClick={() => toggleCodeService({ key: p.key })}
                      >
                        <img src={p.image} alt="" />
                        <span>{p.title}</span>
                      </button>
                    )];
                  })}
                </div>
              )}
              <button type="submit" disabled={codeBusy === "create"}>
                {codeBusy === "create" ? <LoaderCircle size={12} className="spin-icon" /> : <Gift size={12} />}
                {codeBusy === "create" ? "生成中" : "生成兑换码"}
              </button>
                </>
              )}
            </form>
            )}
            {codeResult && codeType !== "history" && <div className={`admin-alert ${codeResult.type}`}>{codeResult.message}</div>}
            {codeType !== "history" && (
              <>
            <div className="admin-code-batch-list">
              {codeBatches.length === 0 ? (
                <div className="admin-userlist-empty">{codesLoading ? "加载中..." : "暂无兑换码批次"}</div>
              ) : codeBatches.map((batch) => (
                <button key={batch.id} type="button" className="admin-code-batch-item" onClick={() => setActiveCodeBatch(batch)}>
                  <span>
                    <strong>
                      {batch.createdByStaffId && <span className="staff-mini-badge inline">{batch.createdByStaffId}</span>}
                      {batch.type === "service" ? "服务码批次" : "余额码批次"} · {batch.quantity || batch.codes?.length || 0} 个
                    </strong>
                    <small>{batch.createdAtBeijing || batch.createdAt} · 备注: {batch.remark || "无"}</small>
                  </span>
                  <span>
                    <b>{batch.type === "service" ? (batch.services || []).map((s) => s.label).join(" + ") : `¥${Number(batch.amount || 0).toFixed(2)}`}</b>
                    <em>可用 {batch.counts?.active || 0} · 作废 {batch.counts?.void || 0}</em>
                  </span>
                </button>
              ))}
            </div>
            <div className="admin-code-list">
              {codes.length === 0 ? (
                <div className="admin-userlist-empty">{codesLoading ? "加载中..." : "暂无兑换码"}</div>
              ) : codes.map((c) => (
                <div key={c.code} className={`admin-code-item status-${c.status}`}>
                  <span>
                    <strong>{c.code}</strong>
                    <small>{c.type === "service" ? "服务兑换码" : "余额兑换码"} · {c.createdAtBeijing || c.createdAt}</small>
                  </span>
                  <span><b>{c.type === "service" ? (c.services || []).map((s) => s.label).join(" + ") : `¥${Number(c.amount || 0).toFixed(2)}`}</b><em>{c.status === "active" ? "可兑换" : c.status === "used" ? "已使用" : "已作废"}</em></span>
                  <span>{c.usedBy || c.usedOrderId || "--"}</span>
                  <div>
                    {canSendRedeemCodes && (
                      <button
                        type="button"
                        disabled={c.status !== "active"}
                        onClick={() => {
                          setSendCodeModal({ code: c.code, type: c.type, label: c.type === "service"
                            ? (c.services || []).map((s) => s.label).join(" + ")
                            : `¥${Number(c.amount || 0).toFixed(2)}` });
                          setSendCodeEmail("");
                          setSendCodeResult(null);
                        }}
                      >发信</button>
                    )}
                    {canManageCodes && <button type="button" disabled={c.status !== "active"} onClick={() => codeAction(c.code, "void")}>作废</button>}
                    {canDeleteRecords && (
                      <button type="button" className="danger" onClick={() => codeAction(c.code, "delete")}><Trash2 size={11} />删除</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
              </>
            )}
          </div>
        ) : tab === "mail" ? (
          <div className="admin-mail-pane">
            <div className="admin-mail-entry-strip">
              <div className="admin-mail-entry-copy">
                <strong><Mail size={15} />客服发信</strong>
                <span>客服邮件与营销邮件分开记录，避免混在一起</span>
              </div>
              <div className="admin-mail-entry-actions">
                <button type="button" onClick={() => openMailComposer("customer")}>
                  <Mail size={13} />写客服邮件
                </button>
                <button type="button" className="secondary" onClick={() => openMailComposer("marketing")}>
                  <Megaphone size={13} />发送营销邮件
                </button>
              </div>
            </div>

            {mailResult && <div className={`admin-alert ${mailResult.type}`}>{mailResult.message}</div>}

            <div className="admin-mail-log">
              <div className="admin-userlist-head">
                <h3>{mailLogType === "marketing" ? "营销邮件记录" : "客服邮件记录"} <em>{visibleMailLogs.length}{mailSearchText ? ` / ${scopedMailLogs.length}` : ""}</em></h3>
                <div className="admin-inline-actions">
                  {canDeleteRecords && (
                    <>
                      <button
                        type="button"
                        className={`admin-filter-btn${mailBatchMode ? " active" : ""}`}
                        onClick={() => {
                          setMailBatchMode((value) => !value);
                          setSelectedMailIds(new Set());
                        }}
                      >{mailBatchMode ? "取消" : "批量"}</button>
                      {mailBatchMode && (
                        <>
                          <button type="button" className="admin-filter-btn" onClick={() => setSelectedMailIds(new Set(visibleMailLogs.map((item) => item.id).filter(Boolean)))}>全选</button>
                          <button type="button" className="admin-filter-btn danger" onClick={deleteSelectedMailLogs} disabled={mailDeleteBusy || selectedMailIds.size === 0}>
                            {mailDeleteBusy ? "删除中" : `删除 ${selectedMailIds.size}`}
                          </button>
                        </>
                      )}
                    </>
                  )}
                  <button type="button" className="admin-filter-btn" onClick={loadMailLogs} disabled={mailLoading}>
                    {mailLoading ? "刷新中" : "刷新"}
                  </button>
                </div>
              </div>
              <div className="admin-mail-log-tabs" role="tablist" aria-label="发信记录分类">
                <button
                  type="button"
                  className={mailLogType === "customer" ? "active" : ""}
                  onClick={() => {
                    setMailLogType("customer");
                    setSelectedMailIds(new Set());
                    setMailBatchMode(false);
                  }}
                >
                  <Mail size={12} />客服记录 <span>{customerMailLogs.length}</span>
                </button>
                <button
                  type="button"
                  className={mailLogType === "marketing" ? "active" : ""}
                  onClick={() => {
                    setMailLogType("marketing");
                    setSelectedMailIds(new Set());
                    setMailBatchMode(false);
                  }}
                >
                  <Megaphone size={12} />营销记录 <span>{marketingMailLogs.length}</span>
                </button>
              </div>
              <div className="admin-mail-search">
                <Search size={13} />
                <input
                  value={mailSearch}
                  onChange={(e) => setMailSearch(e.target.value)}
                  placeholder="按收件邮箱搜索"
                  inputMode="email"
                  autoComplete="off"
                />
                {mailSearch && (
                  <button type="button" onClick={() => setMailSearch("")}>清空</button>
                )}
              </div>
              <div className="admin-mail-log-list">
                {visibleMailLogs.length === 0 ? (
                  <div className="admin-userlist-empty">{mailLoading ? "加载中..." : `暂无${mailLogType === "marketing" ? "营销邮件" : "客服邮件"}记录`}</div>
                ) : visibleMailLogs.map((item) => {
                  const selected = selectedMailIds.has(item.id);
                  const ok = item.ok !== false;
                  const itemIsMarketing = isMarketingMailLog(item);
                  return (
                    <div
                      key={item.id}
                      className={`admin-mail-log-item${ok ? " ok" : " failed"}${mailBatchMode ? " batch-mode" : ""}${selected ? " selected" : ""}`}
                      data-staff-id={item.staffId ? String(item.staffId) : ""}
                      onClick={() => mailBatchMode ? toggleMailSelect(item.id) : setActiveMailLog(item)}
                      role="button"
                      tabIndex={0}
                    >
                      {mailBatchMode && (
                        <span className={`admin-order-checkbox${selected ? " checked" : ""}`} aria-hidden="true">
                          {selected && <CheckCircle2 size={13} />}
                        </span>
                      )}
                      <div className="admin-mail-log-main">
                        <div className="admin-mail-log-row">
                          <strong>{item.to}</strong>
                          {item.staffId && <span className="staff-mini-badge">{item.staffId}</span>}
                          <span className={`admin-mail-type ${itemIsMarketing ? "marketing" : "customer"}`}>{itemIsMarketing ? "营销" : "客服"}</span>
                          <span className={`admin-mail-status ${ok ? "ok" : "failed"}`}>{ok ? "已发送" : "失败"}</span>
                        </div>
                        <small>{item.subject || "客服服务通知"} · {item.createdAtBeijing || item.createdAt}</small>
                        {!ok && item.reason && <em>{item.reason}</em>}
                      </div>
                      <button
                        type="button"
                        className="admin-mail-copy"
                        onClick={(e) => { e.stopPropagation(); copyText(item.to); }}
                        title="复制邮箱"
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : tab === "insights" ? (
          <InsightsPanel />
        ) : tab === "mail-delivery" ? (
          <MailDeliveryPanel />
        ) : tab === "health" ? (
          <SystemHealthPanel />
        ) : tab === "visitors" ? (
          <VisitorsPanel />
        ) : tab === "abandoned" ? (
          <AbandonedPanel />
        ) : tab === "announce" ? (
          <AnnouncePanel />
        ) : tab === "announce-posts" ? (
          <AnnouncePostsPanel />
        ) : tab === "catalog" ? (
          <CatalogPanel />
        ) : tab === "settings" ? (
          <SettingsPanel />
        ) : tab === "security" ? (
          <SecurityPanel isRoot={isRootStaff} />
        ) : tab === "ai-quota" ? (
          <AIQuotaPanel />
        ) : tab === "staff" ? (
          <div className="admin-staff-pane">
            <form className="admin-staff-form" onSubmit={createStaff}>
              <div className="admin-card-title"><UserPlus size={15} />新增工作人员</div>
              <input
                value={staffForm.username}
                onChange={(e) => setStaffForm({ ...staffForm, username: e.target.value })}
                placeholder="账号，3-40位英文/数字"
                autoComplete="off"
                required
              />
              <input
                value={staffForm.password}
                onChange={(e) => setStaffForm({ ...staffForm, password: e.target.value })}
                placeholder="密码，至少6位"
                type="password"
                autoComplete="new-password"
                required
              />
              <select
                value={staffForm.role}
                onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}
                aria-label="角色权限"
              >
                <option value="operator">运营：订单/兑换码/客服邮件</option>
                <option value="support">客服：订单/客服邮件</option>
                <option value="finance">财务：订单/提现审核</option>
              </select>
              <input
                value={staffForm.remark}
                onChange={(e) => setStaffForm({ ...staffForm, remark: e.target.value })}
                placeholder="备注，可选"
                maxLength={80}
              />
              <button type="submit" disabled={staffBusy === "create"}>
                {staffBusy === "create" ? <LoaderCircle size={12} className="spin-icon" /> : <Plus size={12} />}
                {staffBusy === "create" ? "新增中" : "新增人员"}
              </button>
            </form>
            {staffResult && <div className={`admin-alert ${staffResult.type}`}>{staffResult.message}</div>}
            <div className="admin-staff-list">
              {staffPane.staff.map((item) => (
                <div key={item.id} className={`admin-staff-item${item.active === false ? " disabled" : ""}`}>
                  <span className="admin-staff-no">#{item.id}</span>
                  <span>
                    <button
                      type="button"
                      className="admin-staff-account-btn"
                      onClick={() => openStaffActionModal(item)}
                    >
                      {item.username}
                      <em className={`admin-staff-2fa-badge${item.totpEnabled ? " on" : ""}`}>{item.totpEnabled ? "2FA ✓" : "未开2FA"}</em>
                      <em>{staffActionCounts.get(Number(item.id)) || 0} 条记录</em>
                    </button>
                    <small>{item.roleLabel || (item.root ? "主账号" : "运营")} · {item.root ? "环境变量主账号" : (item.remark || "无备注")} · {item.createdAtBeijing || ""}</small>
                  </span>
                  {!item.root && (
                    <>
                      <button type="button" className="admin-userlist-action ban" onClick={() => openStaffManage(item)} title="权限 / 密码 / 会话管理">管理</button>
                      <button type="button" className="admin-userlist-action delete" onClick={() => deleteStaff(item.id)} disabled={staffBusy === "delete" + item.id}>
                        <Trash2 size={11} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="admin-action-log-panel">
              <div className="admin-action-log-head">
                <div className="admin-card-title"><ShieldCheck size={15} />后台操作记录</div>
                <div className="admin-inline-actions">
                  {staffPane.actions.length > 0 && (
                    <button
                      type="button"
                      className="admin-csv-btn"
                      onClick={() => csvDownload(
                        `actions-${csvStamp()}.csv`,
                        ["时间", "操作人", "动作", "对象", "详情"],
                        filteredStaffActions.map((a) => [a.createdAtBeijing || "", a.staffUsername || `#${a.staffId}`, a.action || "", a.target || "", JSON.stringify(a.detail || {})]),
                      )}
                    ><Download size={13} />导出CSV</button>
                  )}
                </div>
              </div>
              <div className="admin-search admin-search-mini" style={{ marginBottom: 10 }}>
                <Search size={13} />
                <input
                  value={actionSearch}
                  onChange={(e) => setActionSearch(e.target.value)}
                  placeholder="搜索动作 / 对象 / 操作人(如 refund、staff:2、order_)"
                />
              </div>
              {actionSearch.trim() && (
                <div className="admin-tx-list" style={{ marginBottom: 12 }}>
                  <div className="admin-tx-list-label">匹配 {filteredStaffActions.length} 条{filteredStaffActions.length > 50 ? " · 显示前 50" : ""}</div>
                  {filteredStaffActions.slice(0, 50).map((a) => (
                    <div key={a.id} className="admin-tx-item">
                      <div className="admin-tx-item-info">
                        <strong>{a.action} · {a.target}</strong>
                        <small>{a.createdAtBeijing} · {a.staffUsername || `#${a.staffId}`}{a.detail && Object.keys(a.detail).length ? ` · ${JSON.stringify(a.detail).slice(0, 120)}` : ""}</small>
                      </div>
                    </div>
                  ))}
                  {filteredStaffActions.length === 0 && (
                    <div className="admin-tx-item"><div className="admin-tx-item-info"><small>无匹配记录</small></div></div>
                  )}
                </div>
              )}
              <div className="admin-action-staff-summary" aria-label="工作人员操作记录">
                {staffPane.staff.map((staff) => {
                  const actions = staffPane.actions.filter((action) => Number(action.staffId || 1) === Number(staff.id));
                  return (
                    <button
                      type="button"
                      key={staff.id}
                      className="admin-action-staff-card"
                      onClick={() => openStaffActionModal(staff)}
                    >
                      <strong>{staff.username}</strong>
                      <span>{actions.length} 条记录</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : tab === "balance" ? (
          <div className="admin-balance-pane">
            <div className="admin-global-log">
              <div className="admin-global-log-head">
                <h3>全部余额变动记录</h3>
                <div className="admin-global-log-stats">
                  <span className="stat-add">累计加 <b>+¥{globalLog.totalAdded.toFixed(2)}</b></span>
                  <span className="stat-deduct">累计减 <b>−¥{globalLog.totalDeducted.toFixed(2)}</b></span>
                </div>
                {globalLog.entries.length > 0 && (
                  <button type="button" className="admin-csv-btn" onClick={exportBalanceCsv} title="导出余额变动 CSV"><Download size={13} />导出CSV</button>
                )}
                {canDeleteRecords && (
                  <div className="admin-inline-actions">
                    <button
                      type="button"
                      className={`admin-filter-btn${logBatchMode ? " active" : ""}`}
                      onClick={() => {
                        setLogBatchMode((value) => !value);
                        setSelectedLogIds(new Set());
                        setLogDeleteResult(null);
                      }}
                    >{logBatchMode ? "取消" : "批量"}</button>
                    {logBatchMode && (
                      <>
                        <button type="button" className="admin-filter-btn" onClick={() => setSelectedLogIds(new Set(globalLog.entries.map((tx) => tx.id).filter(Boolean)))}>全选</button>
                        <button type="button" className="admin-filter-btn danger" onClick={deleteSelectedBalanceLogs} disabled={logDeleteBusy || selectedLogIds.size === 0}>
                          {logDeleteBusy ? "删除中" : `删除 ${selectedLogIds.size}`}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {logDeleteResult && <div className={`admin-alert ${logDeleteResult.type}`}>{logDeleteResult.message}</div>}
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
                  <div className="admin-tx-item"><div className="admin-tx-item-info"><small>暂无变动记录</small></div></div>
                ) : globalLog.entries.map((tx) => {
                  const selected = selectedLogIds.has(tx.id);
                  return (
                  <div
                    key={tx.id}
                    className={`admin-tx-item admin-global-log-item${tx.amount > 0 ? " positive" : " negative"}${logBatchMode ? " batch-mode" : ""}${selected ? " selected" : ""}`}
                    onClick={() => logBatchMode && toggleLogSelect(tx.id)}
                    role={logBatchMode ? "button" : undefined}
                    tabIndex={logBatchMode ? 0 : undefined}
                  >
                    {logBatchMode && (
                      <span className={`admin-order-checkbox${selected ? " checked" : ""}`} aria-hidden="true">
                        {selected && <CheckCircle2 size={13} />}
                      </span>
                    )}
                    <div className="admin-tx-item-info">
                      <div className="admin-global-log-row">
                        <strong>{tx.email}</strong>
                        {tx.staffId && <span className="staff-mini-badge">{tx.staffId}</span>}
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
                  );
                })}
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
          <div className="admin-date-range">
            <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} aria-label="起始日期" />
            <span>—</span>
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} aria-label="结束日期" />
            {(dateFrom || dateTo) && (
              <button type="button" className="admin-date-clear" onClick={() => { setDateFrom(""); setDateTo(""); }} title="清除日期">清除</button>
            )}
            <button type="button" className="admin-csv-btn" onClick={downloadOrdersCsv} title="按当前筛选导出 CSV"><Download size={13} />导出CSV</button>
          </div>
          {tab === "abnormal" ? (
            <div className="admin-abnormal-chip">
              <AlertTriangle size={13} />
              无效订单与超时未处理订单
            </div>
          ) : (
            <div className="admin-filter">
              {[
                { v: "all", label: "全部" },
                { v: "awaiting_quote", label: "待报价" },
                { v: "pending_payment", label: "待付款" },
                { v: "quote_expired", label: "报价失效" },
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
          )}
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
              {isRootStaff && (
                <button
                  type="button"
                  className="admin-batch-action delete"
                  disabled={batchBusy || selectedIds.size === 0}
                  onClick={() => setBatchConfirm("delete")}
                >
                  <Trash2 size={12} />删除
                </button>
              )}
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
              {batchConfirm === "delete" && " 删除不可恢复"}
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
          <div className="admin-orders admin-orders-skeleton">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="admin-skeleton-row">
                <span className="admin-skeleton-bar w40" />
                <span className="admin-skeleton-bar w70" />
                <span className="admin-skeleton-bar w25" />
              </div>
            ))}
          </div>
        ) : orders.length === 0 ? (
          <div className="admin-empty"><Inbox size={36} /><p>{tab === "abnormal" ? "暂无异常订单" : "暂无订单"}</p></div>
        ) : (
          <div className="admin-orders">
            {orders.map((o) => {
              const isSelected = selectedIds.has(o.orderId);
              const isNew = highlightOrderIds.has(o.orderId);
              const passwordAttention = getSpotifyPasswordAttention(o);
              return (
                <div
                  key={o.orderId}
                  className={`admin-order-card status-${o.status}${batchMode ? " batch-mode" : ""}${isSelected ? " selected" : ""}${isNew ? " is-new" : ""}`}
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
                      <span className="admin-card-badges">
                        {o.lastStaffId && <span className="staff-mini-badge">{o.lastStaffId}</span>}
                        {o.referral?.levelOneEmail && (
                          <span className="staff-mini-badge">{referralCommissionLabel(o)}</span>
                        )}
                        {o.usdtConfirmedAt && <span className="usdt-chain-badge" title={o.usdtTxId ? `链上已确认 · ${o.usdtTxId}` : "链上已确认"}>链上已确认</span>}
                        <span className="admin-order-status-stack">
                          <span className={`admin-order-status status-${o.status}`}>
                            {o.status === "completed" ? <CheckCircle2 size={11} /> : o.status === "invalid" ? <AlertTriangle size={11} /> : <Clock size={11} />}
                            {STATUS_LABEL[o.status]}
                          </span>
                          {passwordAttention.updated && (
                            <span className="admin-order-customer-update" title={passwordAttention.updatedAtBeijing || "用户已提交最新资料"}>
                              用户已更新
                            </span>
                          )}
                        </span>
                      </span>
                    </div>
                    <div className="admin-order-mid">
                      <span className="admin-order-service">{o.serviceLabel}</span>
                      {o.itemCount > 1 && <span className="admin-order-count">{o.itemCount} 件</span>}
                    </div>
                    {tab === "abnormal" && o.abnormalReason && (
                      <div className={`admin-order-abnormal ${o.abnormalLevel || ""}`}>
                        <AlertTriangle size={11} />{o.abnormalReason}
                      </div>
                    )}
                    <div className="admin-order-bot">
                      <span className="admin-order-paid">
                        {o.status === "awaiting_quote"
                          ? "待报价"
                          : o.status === "pending_payment"
                          ? `报价 ¥${Number(o.quoteAmount || 0).toFixed(2)}`
                          : o.status === "quote_expired"
                          ? `报价 ¥${Number(o.quoteAmount || 0).toFixed(2)} · 已失效`
                          : o.paidCurrency === "CODE"
                          ? "兑换码"
                          : o.paidCurrency === "USDT"
                          ? `${o.paidAmount} USDT`
                          : `¥${o.paidAmount}`}
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
        {orders.length > 0 && (
          <div className="admin-orders-footer">
            <span className="admin-orders-count">已显示 {orders.length} / 共 {ordersMeta.filteredCount} 单{(dateFrom || dateTo || appliedSearch || (filterStatus !== "all" && tab !== "abnormal")) ? "（筛选后）" : ""}</span>
            {ordersMeta.hasMore && (
              <button
                type="button"
                className="admin-loadmore-btn"
                disabled={ordersLoadingMore}
                onClick={() => loadOrders(appliedSearch, tab === "abnormal" ? "abnormal" : filterStatus, { append: true, offset: orders.length, limit: 100, from: dateFrom, to: dateTo })}
              >{ordersLoadingMore ? <><LoaderCircle size={13} className="spin-icon" />加载中</> : "加载更多"}</button>
            )}
          </div>
        )}
        </>
        )}
          </div>
        </div>
      </main>

      {activeStaffAction && (
        <div className="admin-modal-mask" onClick={() => setActiveStaffAction(null)}>
          <div className="admin-modal admin-compact-modal admin-action-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">{activeStaffAction.staff?.username || "工作人员"}</div>
                <div className="admin-modal-status status-received">{activeStaffAction.actions.length} 条操作记录</div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => setActiveStaffAction(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="admin-modal-body">
              {actionDeleteResult && <div className={`admin-alert ${actionDeleteResult.type}`}>{actionDeleteResult.message}</div>}
              {activeStaffAction.actions.length > 0 && (
                <div className="admin-action-modal-tools">
                  <button
                    type="button"
                    className="admin-filter-btn"
                    onClick={() => {
                      setSelectedActionIds((current) => {
                        const next = new Set(current);
                        if (activeStaffAllSelected) {
                          activeStaffActionIds.forEach((id) => next.delete(id));
                        } else {
                          activeStaffActionIds.forEach((id) => next.add(id));
                        }
                        return next;
                      });
                    }}
                    disabled={actionDeleteBusy}
                  >
                    {activeStaffAllSelected ? "取消全选" : "全选"}
                  </button>
                  <button
                    type="button"
                    className="admin-filter-btn danger"
                    onClick={deleteSelectedActions}
                    disabled={activeStaffSelectedCount === 0 || actionDeleteBusy}
                  >
                    {actionDeleteBusy ? "删除中" : `删除 ${activeStaffSelectedCount}`}
                  </button>
                </div>
              )}
              <div className="admin-action-detail-list">
                {activeStaffAction.actions.length === 0 ? (
                  <div className="admin-action-detail-empty">暂无操作记录</div>
                ) : activeStaffAction.actions.map((item) => (
                  <div key={item.id} className={`admin-action-detail-item${selectedActionIds.has(item.id) ? " selected" : ""}`}>
                    <label className="admin-action-detail-check" aria-label="选择操作记录">
                      <input
                        type="checkbox"
                        checked={selectedActionIds.has(item.id)}
                        disabled={!item.id || actionDeleteBusy}
                        onChange={(e) => {
                          setSelectedActionIds((current) => {
                            const next = new Set(current);
                            if (e.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          });
                        }}
                      />
                    </label>
                    <div className="admin-action-detail-main">
                      <div>
                        <strong>{item.actionLabel || item.action}</strong>
                        <small>{item.createdAtBeijing}</small>
                      </div>
                      <p>{actionDetailText(item)}</p>
                      <span>{item.targetLabel || item.target || "系统"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

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
              <button type="button" className="admin-modal-close" onClick={() => !saving && setActiveOrder(null)} disabled={saving} aria-label="关闭订单详情">
                <X size={16} />
              </button>
            </div>

            <div className="admin-modal-body">
              {/* Order summary */}
              <section className="admin-modal-section">
                <h3>订单概览</h3>
                <div className="admin-summary-grid">
                  <div><span>下单时间</span><b>{activeOrder.createdAtBeijing}</b></div>
                  <div><span>支付方式</span><b>{activeOrder.paymentMethod === "quote" ? "等待报价付款" : activeOrder.paymentMethod === "redeem" ? "服务兑换码" : activeOrder.paymentMethod === "usdt" ? "USDT-TRC20" : "支付宝"}</b></div>
                  <div><span>{["pending_payment", "quote_expired"].includes(activeOrder.status) ? "报价金额" : "实付金额"}</span><b>{activeOrder.status === "awaiting_quote" ? "尚未报价" : activeOrder.status === "pending_payment" ? `¥${Number(activeOrder.quoteAmount || 0).toFixed(2)} · 未付款` : activeOrder.status === "quote_expired" ? `¥${Number(activeOrder.quoteAmount || 0).toFixed(2)} · 已失效` : activeOrder.paidCurrency === "CODE" ? "兑换码抵扣" : activeOrder.paidCurrency === "USDT" ? `${activeOrder.paidAmount} USDT` : `¥${activeOrder.paidAmount}`}</b></div>
                  <div><span>件数</span><b>{activeOrder.itemCount} 件</b></div>
                  {activeOrder.paidCurrency === "USDT" && (
                    <div className="span-2">
                      <span>链上到账</span>
                      <b className="admin-summary-remark">
                        {activeOrder.usdtConfirmedAt
                          ? `已确认 · ${activeOrder.usdtConfirmedAmount || activeOrder.usdtPayAmount} USDT${activeOrder.usdtConfirmedAtBeijing ? ` · ${activeOrder.usdtConfirmedAtBeijing}` : ""}${activeOrder.usdtTxId ? ` · TX ${activeOrder.usdtTxId}` : ""}`
                          : `待确认${activeOrder.usdtPayAmount ? ` · 应付 ${activeOrder.usdtPayAmount} USDT` : ""}`}
                      </b>
                    </div>
                  )}
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
                  {activeOrder.referral?.levelOneEmail && (
                    <div className="span-2">
                      <span>邀请返佣</span>
                      <b className="admin-summary-remark">
                        邀请人 {activeOrder.referral.levelOneEmail}
                        {activeOrder.referral.inviteCode ? ` · 邀请码 ${activeOrder.referral.inviteCode}` : ""}
                        {` · ${referralCommissionLabel(activeOrder)}`}
                        {activeOrder.referralCommissionSettledAtBeijing ? ` · ${activeOrder.referralCommissionSettledAtBeijing}` : ""}
                      </b>
                    </div>
                  )}
                  {activeOrder.refundedAt && (
                    <div className="span-2">
                      <span>作废退款</span>
                      <b className="admin-summary-remark">
                        {Number(activeOrder.refund?.balance || 0) > 0 ? `退余额 ¥${Number(activeOrder.refund.balance).toFixed(2)}` : ""}
                        {activeOrder.refund?.coupon ? " · 已还优惠券" : ""}
                        {Number(activeOrder.refund?.balance || 0) <= 0 && !activeOrder.refund?.coupon ? "无需退款" : ""}
                        {activeOrder.refundedAtBeijing ? ` · ${activeOrder.refundedAtBeijing}` : ""}
                      </b>
                    </div>
                  )}
                  {activeOrder.staffAudit?.[0] && (
                    <div className="span-2"><span>最近操作</span><b>{activeOrder.staffAudit[0].label || `#${activeOrder.staffAudit[0].staffId}`} · {activeOrder.staffAudit[0].createdAtBeijing}</b></div>
                  )}
                </div>
              </section>

              {activeOrder.orderType === "proxy_payment" && (
                <section className="admin-modal-section admin-proxy-order-section">
                  <div className="admin-proxy-section-head">
                    <div>
                      <span>代付需求</span>
                      <h3>核验平台并发送报价</h3>
                    </div>
                    <img src="/products/proxy-pay.jpg" alt="全球代付" />
                  </div>
                  <div className="admin-proxy-request-grid">
                    <div className="span-2">
                      <span>网站 / 平台</span>
                      <a href={activeOrder.platformUrl} target="_blank" rel="noopener noreferrer">{activeOrder.platformUrl}<ExternalLink size={11} /></a>
                    </div>
                    <div><span>商品标价</span><b>{activeOrder.productPrice || "--"}</b></div>
                    <div><span>联系用户</span><b>{activeOrder.contact || "--"}</b></div>
                    {activeOrder.quotedAtBeijing && <div><span>报价时间</span><b>{activeOrder.quotedAtBeijing}</b></div>}
                    {activeOrder.quoteExpiresAtBeijing && <div><span>付款截止</span><b>{activeOrder.quoteExpiresAtBeijing}</b></div>}
                    {activeOrder.paymentSubmittedAtBeijing && <div><span>用户提交付款</span><b>{activeOrder.paymentSubmittedAtBeijing}</b></div>}
                  </div>
                  {["awaiting_quote", "pending_payment", "quote_expired"].includes(activeOrder.status) && (
                    <div className="admin-proxy-quote-row">
                      <label className="admin-field">
                        <span>报价金额(CNY) <em>*</em></span>
                        <div className="admin-proxy-amount-input"><i>¥</i><input type="number" min="0.01" max="1000000" step="0.01" value={editForm.quoteAmount} onChange={(e) => setEditForm({ ...editForm, quoteAmount: e.target.value })} placeholder="0.00" /></div>
                      </label>
                      <label className="admin-field admin-proxy-validity-field">
                        <span>报价有效期</span>
                        <select value={editForm.quoteValidDays || "7"} onChange={(e) => setEditForm({ ...editForm, quoteValidDays: e.target.value })}>
                          <option value="1">1 天</option>
                          <option value="3">3 天</option>
                          <option value="7">7 天</option>
                          <option value="14">14 天</option>
                        </select>
                      </label>
                      <button type="button" className="admin-save-btn admin-proxy-quote-btn" onClick={sendProxyQuote} disabled={saving || !editForm.quoteAmount}>
                        {saving ? <><LoaderCircle size={13} className="spin-icon" />发送中</> : <><Mail size={13} />{activeOrder.status === "awaiting_quote" ? "发送报价邮件" : "重新报价并发送"}</>}
                      </button>
                    </div>
                  )}
                  {activeOrder.quoteEmailSentAtBeijing && (
                    <p className={`admin-proxy-mail-state${activeOrder.quoteEmailOk ? " ok" : " failed"}`}>{activeOrder.quoteEmailOk ? "报价邮件已发送" : "报价邮件发送失败"} · {activeOrder.quoteEmailSentAtBeijing}</p>
                  )}
                </section>
              )}

              {/* Items */}
              <section className="admin-modal-section">
                <h3>商品配置 · {editForm.items.length} 件</h3>
                {editForm.items.map((it, idx) => {
                  const isRocket = it.service === "rocket";
                  const isSpotify = it.service === "spotify";
                  const isProxy = it.service === "proxy-pay";
                  const isStaffFill = !isSpotify && !isRocket && !isProxy; // netflix/disney/max
                  return (
                    <div key={idx} className="admin-item-card">
                      <div className="admin-item-head">
                        <strong>{idx + 1}. {it.label}</strong>
                        <div className="admin-item-head-actions">
                          {!isRocket && (
                            <span className="admin-item-tag">{isStaffFill ? "客服填写账号密码" : "可修改买家输入"}</span>
                          )}
                          {isSpotify && (
                            <button
                              type="button"
                              className="admin-spotify-password-mail-trigger"
                              onClick={() => setSpotifyPasswordMail((current) => current?.index === idx ? null : { index: idx, note: it.passwordCorrectionStaffNote || "" })}
                              disabled={spotifyPasswordMailBusy}
                            >
                              <Mail size={12} />密码错误
                            </button>
                          )}
                        </div>
                      </div>
                      {isSpotify && spotifyPasswordMail?.index === idx && (
                        <div className="admin-spotify-password-mail-row">
                          <input
                            value={spotifyPasswordMail.note}
                            onChange={(event) => setSpotifyPasswordMail({ index: idx, note: event.target.value })}
                            placeholder="补充说明（选填，将随邮件发送）"
                            maxLength={500}
                            autoFocus
                          />
                          <button type="button" onClick={() => sendSpotifyPasswordError(idx)} disabled={spotifyPasswordMailBusy}>
                            {spotifyPasswordMailBusy ? <LoaderCircle size={13} className="spin-icon" /> : <Mail size={13} />}
                            {spotifyPasswordMailBusy ? "发送中" : "发送邮件"}
                          </button>
                          <button type="button" className="cancel" onClick={() => setSpotifyPasswordMail(null)} disabled={spotifyPasswordMailBusy}>取消</button>
                        </div>
                      )}
                      {isProxy ? (
                        <p className="admin-proxy-item-note">代付订单无需填写账号密码，按上方需求核验并报价。</p>
                      ) : isStaffFill ? (
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
                      ) : isRocket ? null : (
                        <>
                          <label className="admin-field">
                            <span>账号(可改)</span>
                            <input
                              value={it.account}
                              onChange={(e) => updateItem(idx, "account", e.target.value)}
                            />
                          </label>
                          {isSpotify && (
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
                  {activeOrder.orderType === "proxy_payment" ? (
                    <>
                      <option value="awaiting_quote">等待报价</option>
                      <option value="pending_payment" disabled={!activeOrder.quoteAmount || activeOrder.status === "quote_expired"}>等待付款</option>
                      <option value="quote_expired" disabled>报价已失效</option>
                      <option value="received" disabled={["awaiting_quote", "quote_expired"].includes(activeOrder.status)}>订单已收到</option>
                      <option value="completed" disabled={!['received', 'completed'].includes(activeOrder.status)}>代付已完成(发送邮件)</option>
                      <option value="invalid">订单无效</option>
                    </>
                  ) : (
                    <>
                      <option value="received">订单已收到</option>
                      <option value="completed">订单已完成(发开通邮件)</option>
                      <option value="invalid">无效·未收到付款</option>
                    </>
                  )}
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
              {isRootStaff && (
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
              )}
              <div className="admin-pdf-export-row">
                <button type="button" onClick={() => openPdfRemarkModal("order", activeOrder)}>
                  <Download size={13} />导出订单 PDF
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pdfExportModal && (
        <div className="admin-modal-mask admin-pdf-note-mask" onClick={() => setPdfExportModal(null)}>
          <div className="admin-modal admin-compact-modal admin-pdf-note-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">导出 PDF</div>
                <div className="admin-modal-status status-received">可添加一句备注</div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => setPdfExportModal(null)}><X size={16} /></button>
            </div>
            <form className="admin-modal-body admin-pdf-note-form" onSubmit={submitPdfExport}>
              <label>
                <span>备注内容，可留空</span>
                <textarea
                  value={pdfExportModal.note}
                  onChange={(e) => setPdfExportModal({ ...pdfExportModal, note: e.target.value.slice(0, 180) })}
                  onFocus={(e) => {
                    const el = e.currentTarget;
                    setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
                  }}
                  placeholder="例如：客户补发凭证 / 售后核对使用"
                  rows={3}
                  maxLength={180}
                />
              </label>
              <small>{String(pdfExportModal.note || "").length}/180</small>
              <div className="admin-mail-detail-actions">
                <button type="button" onClick={() => setPdfExportModal(null)}>取消</button>
                <button type="submit"><Download size={12} />生成 PDF</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {mailComposeOpen && (
        <div className="admin-modal-mask" onClick={() => !mailBusy && !mailRecipientBusy && setMailComposeOpen(false)}>
          <div className="admin-modal admin-compact-modal admin-mail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">{mailMode === "marketing" ? "营销邮件" : "客服发信"}</div>
                <div className="admin-modal-status status-received">
                  {mailMode === "marketing" ? "数字会员服务台模板" : "冒央会社客服人员"}
                </div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => setMailComposeOpen(false)} disabled={mailBusy || mailRecipientBusy}><X size={16} /></button>
            </div>
            <div className="admin-modal-body">
              <div className="admin-mail-mode-row">
                <button
                  type="button"
                  className={mailMode === "customer" ? "active" : ""}
                  onClick={() => applyMailComposerMode("customer")}
                  disabled={mailBusy || mailRecipientBusy}
                >客服邮件</button>
                <button
                  type="button"
                  className={mailMode === "marketing" ? "active" : ""}
                  onClick={() => { applyMailComposerMode("marketing"); loadMarketingMailTemplate(); }}
                  disabled={mailBusy || mailRecipientBusy}
                >营销邮件</button>
              </div>
              {mailMode === "customer" && (
                <div className="admin-mail-tpl-row">
                  <span className="admin-mail-tpl-label">快捷模板</span>
                  {mailTemplates.length === 0 && <em className="admin-mail-tpl-empty">暂无 · 填好正文后点「存为模板」</em>}
                  {mailTemplates.map((t) => (
                    <span key={t.id} className="admin-mail-tpl-chip">
                      <button type="button" title={t.subject} onClick={() => setMailForm((f) => ({ ...f, subject: t.subject || f.subject, content: t.content }))}>{t.name}</button>
                      <button type="button" className="tpl-del" aria-label="删除模板" onClick={() => deleteMailTemplate(t.id, t.name)}>×</button>
                    </span>
                  ))}
                  <button type="button" className="admin-mail-tpl-save" onClick={saveMailTemplate} disabled={mailTplBusy}>+ 存为模板</button>
                </div>
              )}
              <form className="admin-mail-form" onSubmit={sendCustomerMail}>
                <div className="admin-mail-form-grid">
                  <label>
                    <span>收件邮箱</span>
                    <input
                      type="text"
                      inputMode="email"
                      value={mailForm.to}
                      onChange={(e) => setMailForm({ ...mailForm, to: e.target.value })}
                      placeholder="customer@example.com, another@example.com"
                      required
                    />
                  </label>
                  <label>
                    <span>邮件主题</span>
                    <input
                      value={mailForm.subject}
                      onChange={(e) => setMailForm({ ...mailForm, subject: e.target.value })}
                      placeholder="客服服务通知"
                      maxLength={80}
                      required
                    />
                  </label>
                </div>
                {mailMode === "marketing" && (
                  <div className="admin-mail-bulk-row">
                    <button type="button" onClick={fillRegisteredMailRecipients} disabled={!canViewUsers || mailRecipientBusy || mailBusy}>
                      {mailRecipientBusy ? <LoaderCircle size={12} className="spin-icon" /> : <Users size={12} />}
                      读取注册用户
                    </button>
                    <button type="button" onClick={fillOrderMailRecipients} disabled={mailRecipientBusy || mailBusy}>
                      {mailRecipientBusy ? <LoaderCircle size={12} className="spin-icon" /> : <ClipboardList size={12} />}
                      读取订单邮箱
                    </button>
                    <button type="button" onClick={fillAllMarketingRecipients} disabled={!canViewUsers || mailRecipientBusy || mailBusy}>
                      {mailRecipientBusy ? <LoaderCircle size={12} className="spin-icon" /> : <Users size={12} />}
                      读取全部来源
                    </button>
                    <button type="button" className="primary" onClick={sendMarketingMailToRegisteredUsers} disabled={mailRecipientBusy || mailBusy || (mailRecipientPool.emails || []).length === 0}>
                      {mailBusy ? <LoaderCircle size={12} className="spin-icon" /> : <Megaphone size={12} />}
                      批量发送已读取
                    </button>
                    <span>
                      {mailRecipientPool.emails.length
                        ? `已读取 ${mailRecipientPool.emails.length} 个去重邮箱（注册 ${mailRecipientPool.registered} / 订单 ${mailRecipientPool.orders}），发送时每批 ${MAIL_BATCH_LIMIT} 个自动发完`
                        : canViewUsers ? `可读取注册用户与历史订单联系邮箱，每批 ${MAIL_BATCH_LIMIT} 个自动发送` : "读取注册用户邮箱需要用户查看权限；历史订单邮箱可单独读取"}
                    </span>
                  </div>
                )}
                {mailMode === "marketing" ? (
                  <label className="admin-mail-body-field admin-mail-html-field">
                    <span>营销邮件 HTML（默认模板，可手动编辑后发送）</span>
                    <textarea
                      value={mailMarketingHtml}
                      onChange={(e) => setMailMarketingHtml(e.target.value)}
                      placeholder={mailMarketingLoading ? "正在读取默认营销邮件 HTML..." : "粘贴或编辑完整 HTML 邮件源码"}
                      rows={13}
                      maxLength={120000}
                      required
                    />
                    <small>
                      {mailMarketingLoading ? "默认 HTML 读取中..." : "手动发送使用上方收件邮箱；批量发送使用已读取邮箱池。"}
                      <button type="button" onClick={() => loadMarketingMailTemplate(true)} disabled={mailMarketingLoading || mailBusy}>恢复默认 HTML</button>
                    </small>
                  </label>
                ) : (
                  <label className="admin-mail-body-field">
                    <span>正文内容</span>
                    <textarea
                      value={mailForm.content}
                      onChange={(e) => setMailForm({ ...mailForm, content: e.target.value })}
                      placeholder="输入需要告知用户的内容；邮件会自动加入客服开头与结尾。"
                      rows={7}
                      maxLength={3000}
                      required
                    />
                  </label>
                )}
                <div className="admin-mail-helper">
                  {mailMode === "marketing" ? (
                    <>
                      <span>手动邮箱用逗号隔开</span>
                      <span>HTML 可手动编辑</span>
                      <span>批量发送读取完整邮箱池</span>
                    </>
                  ) : (
                    <>
                      <span>多个邮箱用英文逗号隔开</span>
                      <span>自动加入客服开头与结尾</span>
                      <span>正文保留换行</span>
                    </>
                  )}
                </div>
                {mailBatchProgress && mailMode === "marketing" && (
                  <div className="admin-mail-progress">
                    已处理 {mailBatchProgress.batch}/{mailBatchProgress.batches} 批 · 成功 {mailBatchProgress.sent}/{mailBatchProgress.total} · 失败 {mailBatchProgress.failed}
                  </div>
                )}
                <button type="submit" disabled={mailBusy}>
                  {mailBusy ? <LoaderCircle size={12} className="spin-icon" /> : <Mail size={12} />}
                  {mailBusy ? "发送中" : (mailMode === "marketing" ? "发送营销邮件" : "发送邮件")}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {activeMailLog && (
        <div className="admin-modal-mask" onClick={() => setActiveMailLog(null)}>
          <div className="admin-modal admin-compact-modal admin-mail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">发信记录</div>
                <div className={`admin-modal-status ${activeMailLog.ok === false ? "status-invalid" : "status-received"}`}>{activeMailLog.ok === false ? "发送失败" : "已发送"}</div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => setActiveMailLog(null)}><X size={16} /></button>
            </div>
            <div className="admin-modal-body">
              <div className="admin-mail-detail-grid">
                <div><span>邮件类型</span><b>{isMarketingMailLog(activeMailLog) ? "营销邮件" : "客服邮件"}</b></div>
                <div><span>收件邮箱</span><b>{activeMailLog.to}</b></div>
                <div><span>工作人员</span><b>#{activeMailLog.staffId || 1}</b></div>
                <div><span>发送时间</span><b>{activeMailLog.createdAtBeijing || activeMailLog.createdAt}</b></div>
                <div><span>邮件主题</span><b>{activeMailLog.subject || "客服服务通知"}</b></div>
              </div>
              <div className="admin-mail-detail-content">
                <span>完整正文</span>
                <p>{activeMailLog.content || activeMailLog.preview || "--"}</p>
              </div>
              {activeMailLog.ok === false && activeMailLog.reason && (
                <div className="admin-alert error">{activeMailLog.reason}</div>
              )}
              <div className="admin-mail-detail-actions">
                <button type="button" onClick={() => copyText(activeMailLog.to)}><Copy size={12} />复制邮箱</button>
                <button type="button" onClick={() => copyText(activeMailLog.content || activeMailLog.preview || "")}><Copy size={12} />复制正文</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {staffManage && (
        <div className="admin-modal-mask" onClick={() => !staffManageBusy && setStaffManage(null)}>
          <div className="admin-modal admin-compact-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">{staffManage.staff.username}</div>
                <div className="admin-modal-status status-received">#{staffManage.staff.id} · 权限 / 密码 / 会话管理</div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => setStaffManage(null)} disabled={Boolean(staffManageBusy)}><X size={16} /></button>
            </div>
            <div className="admin-modal-body">
              <div className="admin-settings-grid" style={{ marginBottom: 4 }}>
                <div className="admin-settings-field">
                  <label>角色预设</label>
                  <select
                    value={staffManage.role}
                    onChange={(e) => setStaffManage({ ...staffManage, role: e.target.value })}
                    style={{ width: "100%", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 9, fontSize: 13 }}
                  >
                    <option value="operator">运营</option>
                    <option value="support">客服</option>
                    <option value="finance">财务</option>
                  </select>
                </div>
                <div className="admin-settings-field">
                  <label>备注</label>
                  <input value={staffManage.remark} maxLength={80} onChange={(e) => setStaffManage({ ...staffManage, remark: e.target.value })} />
                </div>
              </div>

              <div className="admin-staff-perms">
                <div className="admin-staff-perms-title">细粒度权限(逐项覆盖角色预设)</div>
                <div className="admin-staff-perms-grid">
                  {STAFF_PERM_LABELS.map(([key, label]) => (
                    <label key={key} className={`admin-staff-perm${staffManage.perms[key] ? " on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={Boolean(staffManage.perms[key])}
                        onChange={(e) => setStaffManage({ ...staffManage, perms: { ...staffManage.perms, [key]: e.target.checked } })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="admin-settings-grid">
                <div className="admin-settings-field">
                  <label>重置密码(留空不改)</label>
                  <input type="password" autoComplete="new-password" placeholder="至少 6 位" value={staffManage.password} onChange={(e) => setStaffManage({ ...staffManage, password: e.target.value })} />
                </div>
                <div className="admin-settings-field" style={{ display: "flex", alignItems: "flex-end" }}>
                  <label className="admin-settings-check" style={{ color: staffManage.active ? "var(--accent)" : "#b91c1c" }}>
                    <input type="checkbox" checked={staffManage.active} onChange={(e) => setStaffManage({ ...staffManage, active: e.target.checked })} />
                    {staffManage.active ? "账号启用中" : "已停用(无法登录)"}
                  </label>
                </div>
              </div>

              {staffManageMsg && <div className={`admin-alert ${staffManageMsg.type}`}>{staffManageMsg.message}</div>}
              <div className="admin-staff-manage-actions">
                <button type="button" className="admin-settings-btn" onClick={resetStaff2fa} disabled={Boolean(staffManageBusy)} title="员工丢失验证器时,解除其两步验证并踢下线">
                  {staffManageBusy === "reset2fa" ? <LoaderCircle size={13} className="spin-icon" /> : <ShieldCheck size={13} />}重置2FA
                </button>
                <button type="button" className="admin-settings-btn" onClick={kickStaff} disabled={Boolean(staffManageBusy)}>
                  {staffManageBusy === "kick" ? <LoaderCircle size={13} className="spin-icon" /> : <ShieldCheck size={13} />}强制下线
                </button>
                <button type="button" className="admin-settings-btn primary" onClick={saveStaffManage} disabled={Boolean(staffManageBusy)}>
                  {staffManageBusy === "save" ? <LoaderCircle size={13} className="spin-icon" /> : <CheckCircle2 size={13} />}保存(保存后其需重新登录)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {searchOpen && (
        <div className="admin-search-mask" onClick={closeSearch}>
          <div className="admin-search-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-search-input-row">
              <Search size={16} />
              <input
                autoFocus
                value={gQuery}
                onChange={(e) => setGQuery(e.target.value)}
                placeholder="搜索订单号 / 邮箱 / 用户名 / 兑换码…"
              />
              {gLoading ? <LoaderCircle size={15} className="spin-icon" /> : <button type="button" className="admin-search-close" onClick={closeSearch}><X size={15} /></button>}
            </div>
            <div className="admin-search-results">
              {gQuery.trim().length < 2 ? (
                <div className="admin-search-hint">输入至少 2 个字符开始搜索 · Esc 关闭</div>
              ) : (gResults.orders.length + gResults.users.length + gResults.codes.length === 0 && !gLoading) ? (
                <div className="admin-search-hint">无匹配结果</div>
              ) : (
                <>
                  {gResults.orders.length > 0 && (
                    <div className="admin-search-group">
                      <div className="admin-search-group-title">订单</div>
                      {gResults.orders.map((o) => (
                        <button key={o.orderId} type="button" className="admin-search-item" onClick={() => searchGotoOrder(o.orderId)}>
                          <ClipboardList size={14} />
                          <span className="admin-search-item-main">{o.orderId}<em>{o.serviceLabel}</em></span>
                          <span className={`admin-order-status status-${o.status}`}>{o.statusLabel}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {gResults.users.length > 0 && (
                    <div className="admin-search-group">
                      <div className="admin-search-group-title">用户</div>
                      {gResults.users.map((u) => (
                        <button key={u.email} type="button" className="admin-search-item" onClick={() => searchGotoUser(u.email)}>
                          <Users size={14} />
                          <span className="admin-search-item-main">{u.username || "—"}<em>{u.email}</em></span>
                          <span className="admin-search-item-side">¥{Number(u.balance || 0).toFixed(2)}{u.banned ? " · 封禁" : ""}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {gResults.codes.length > 0 && (
                    <div className="admin-search-group">
                      <div className="admin-search-group-title">兑换码</div>
                      {gResults.codes.map((c) => (
                        <button key={c.code} type="button" className="admin-search-item" onClick={searchGotoCode}>
                          <Gift size={14} />
                          <span className="admin-search-item-main">{c.code}<em>{c.typeLabel}{c.usedBy ? ` · ${c.usedBy}` : ""}</em></span>
                          <span className="admin-search-item-side">{c.status}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {userModalOpen && (userInfo || userLoading) && (
        <div className="admin-modal-mask" onClick={closeUserModal}>
          <div className="admin-modal admin-compact-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">{userInfo?.user?.username || userModalTarget || "用户详情"}</div>
                <div className="admin-modal-status status-received">{userInfo ? `余额 ¥${userInfo.user.balance.toFixed(2)}` : "加载中"}</div>
              </div>
              <button type="button" className="admin-modal-close" onClick={closeUserModal} disabled={balBusy}><X size={16} /></button>
            </div>
            <div className="admin-modal-body">
              {!userInfo ? (
                <div className="admin-user-modal-loading">
                  <LoaderCircle size={16} className="spin-icon" />
                  正在载入用户余额与明细
                </div>
              ) : (
              <>
              <div className="admin-user-card">
                <div className="admin-user-head">
                  <span className="admin-user-email">{userInfo.user.email}</span>
                  <span className="admin-user-balance">¥{userInfo.user.balance.toFixed(2)}</span>
                </div>
                <div className="admin-user-meta">注册于 {userInfo.user.createdAtBeijing || "--"}</div>
              </div>

              <div className="admin-user-tabs" role="tablist">
                <button
                  type="button" role="tab" aria-selected={userTab === "balance"}
                  className={userTab === "balance" ? "active" : ""}
                  onClick={() => setUserTab("balance")}
                >余额明细 <span className="admin-user-tab-count">{userInfo.transactions.length}</span></button>
                {userInfo.user.referral && (
                  <button
                    type="button" role="tab" aria-selected={userTab === "referral"}
                    className={userTab === "referral" ? "active" : ""}
                    onClick={() => setUserTab("referral")}
                  >上下级关系 <span className="admin-user-tab-count">{Number(userInfo.user.referral.levelOneCount || 0) + Number(userInfo.user.referral.levelTwoCount || 0)}</span></button>
                )}
                {isRootStaff && (
                  <button
                    type="button" role="tab" aria-selected={userTab === "activity"}
                    className={userTab === "activity" ? "active" : ""}
                    onClick={() => setUserTab("activity")}
                  >访问与行为</button>
                )}
              </div>

              {userTab === "balance" && (
                <div className="admin-user-tabpanel">
                  {canAdjustBalance && (
                    <div className="admin-balance-form">
                      <div className="admin-balance-row">
                        <span>金额</span>
                        <input type="number" inputMode="decimal" step="0.01" min="0.01" value={balForm.amount} onChange={(e) => setBalForm({ ...balForm, amount: e.target.value })} placeholder="例如 100" />
                      </div>
                      <div className="admin-balance-row">
                        <span>原因</span>
                        <textarea value={balForm.reason} onChange={(e) => setBalForm({ ...balForm, reason: e.target.value })} placeholder="将写入余额明细" rows={2} />
                      </div>
                      {balResult && <div className={`admin-alert ${balResult.type}`}>{balResult.message}</div>}
                      <div className="admin-balance-actions">
                        <button type="button" className="admin-balance-add" disabled={balBusy} onClick={() => adjustBalance(+1)}><CheckCircle2 size={13} />增加</button>
                        <button type="button" className="admin-balance-deduct" disabled={balBusy} onClick={() => adjustBalance(-1)}><AlertTriangle size={13} />扣除</button>
                      </div>
                    </div>
                  )}
                  <div className="admin-tx-list">
                    <div className="admin-tx-list-label">余额明细 · {userInfo.transactions.length} 条</div>
                    {userInfo.transactions.length === 0 ? (
                      <div className="admin-tx-item"><div className="admin-tx-item-info"><small>暂无变动记录</small></div></div>
                    ) : userInfo.transactions.map((tx) => (
                      <div key={tx.id} className={`admin-tx-item${tx.amount > 0 ? " positive" : " negative"}`}>
                        <div className="admin-tx-item-info">
                          <strong>{tx.reason}</strong>
                          <small>{tx.createdAtBeijing}{tx.staffId ? ` · #${tx.staffId}` : ""}</small>
                        </div>
                        <div className="admin-tx-item-amount">{tx.amount > 0 ? "+" : ""}¥{Math.abs(tx.amount).toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {userTab === "referral" && userInfo.user.referral && (
                <div className="admin-user-tabpanel">
                  <div className="admin-user-referral-card">
                    <div className="admin-user-referral-head">
                      <strong>上下级关系</strong>
                      <span>邀请码 {userInfo.user.referral.inviteCode || "--"}</span>
                    </div>
                    <div className="admin-user-referral-grid">
                      <div><span>直属上级</span><b>{userInfo.user.referral.invitedByEmail || "无"}</b></div>
                      <div><span>二级上级</span><b>{userInfo.user.referral.invitedBy2Email || "无"}</b></div>
                      <div><span>一级下级</span><b>{Number(userInfo.user.referral.levelOneCount || 0)} 人</b></div>
                      <div><span>二级下级</span><b>{Number(userInfo.user.referral.levelTwoCount || 0)} 人</b></div>
                    </div>
                    <div className="admin-user-downlines">
                      {userInfo.user.referral.downlines?.length ? userInfo.user.referral.downlines.map((item) => (
                        <button key={`${item.level}:${item.email}`} type="button" onClick={() => loadUser(item.email)}>
                          <span>{item.level === 1 ? "一级" : "二级"}</span>
                          <b>{item.email}</b>
                          <em>{item.username || "未命名"} · ¥{Number(item.balance || 0).toFixed(2)}</em>
                        </button>
                      )) : (
                        <div className="admin-user-downlines-empty">暂无下级用户</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {userTab === "activity" && isRootStaff && (
                <div className="admin-user-tabpanel">
                  <UserActivity email={userInfo.user.email} />
                </div>
              )}
              </>
              )}
            </div>
          </div>
        </div>
      )}

      {activeWithdrawal && (
        <div className="admin-modal-mask" onClick={() => !withdrawalBusy && setActiveWithdrawal(null)}>
          <div className="admin-modal admin-compact-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">{activeWithdrawal.withdrawal.username || "提现申请"}</div>
                <div className="admin-modal-status status-received">{activeWithdrawal.withdrawal.statusLabel || "待审核"}</div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => setActiveWithdrawal(null)} disabled={withdrawalBusy}><X size={16} /></button>
            </div>
            <div className="admin-modal-body">
              <div className="admin-withdraw-info-grid">
                <div><span>邮箱</span><b>{activeWithdrawal.withdrawal.userEmail}</b></div>
                <div><span>提现金额</span><b>¥{Number(activeWithdrawal.withdrawal.amount || 0).toFixed(2)}</b></div>
                <div><span>支付宝</span><b>{activeWithdrawal.withdrawal.alipayAccount}</b></div>
                <div><span>姓名</span><b>{activeWithdrawal.withdrawal.realName}</b></div>
                <div><span>当前余额</span><b>¥{Number(activeWithdrawal.user?.balance || 0).toFixed(2)}</b></div>
                <div><span>操作人员</span><b>{activeWithdrawal.withdrawal.updatedByStaffId ? `#${activeWithdrawal.withdrawal.updatedByStaffId}` : "--"}</b></div>
              </div>
              <form className="admin-withdraw-status-form compact" onSubmit={saveWithdrawalStatus}>
                <label>
                  <span>状态</span>
                  <select value={withdrawalStatus} onChange={(e) => setWithdrawalStatus(e.target.value)}>
                    {WITHDRAWAL_STATUS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </label>
                <label>
                  <span>备注</span>
                  <input value={withdrawalNote} onChange={(e) => setWithdrawalNote(e.target.value)} placeholder="内部备注，可选" />
                </label>
                <button type="submit" disabled={withdrawalBusy}>{withdrawalBusy ? <LoaderCircle size={12} className="spin-icon" /> : <CheckCircle2 size={12} />}更新</button>
              </form>
              <div className="admin-tx-list">
                <div className="admin-tx-list-label">该用户余额明细 · {activeWithdrawal.transactions.length} 条</div>
                {activeWithdrawal.transactions.map((tx) => (
                  <div key={tx.id} className={`admin-tx-item${tx.amount > 0 ? " positive" : " negative"}`}>
                    <div className="admin-tx-item-info">
                      <strong>{tx.reason}</strong>
                      <small>{tx.createdAtBeijing}{tx.statusLabel ? ` · ${tx.statusLabel}` : ""}</small>
                    </div>
                    <div className="admin-tx-item-amount">{tx.amount > 0 ? "+" : ""}¥{Math.abs(tx.amount).toFixed(2)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeRedeemHistory && (
        <div className="admin-modal-mask" onClick={() => setActiveRedeemHistory(null)}>
          <div className="admin-modal admin-compact-modal admin-redeem-history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">{activeRedeemHistory.code}</div>
                <div className="admin-modal-status status-received">{activeRedeemHistory.typeLabel} · {activeRedeemHistory.valueLabel}</div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => setActiveRedeemHistory(null)}><X size={16} /></button>
            </div>
            <div className="admin-modal-body">
              <div className="admin-mail-detail-grid">
                <div><span>兑换码</span><b>{activeRedeemHistory.code}</b></div>
                <div><span>对应订单号</span><b>{activeRedeemHistory.usedOrderId || "无订单"}</b></div>
                <div><span>兑换用户</span><b>{activeRedeemHistory.usedBy || "未记录"}</b></div>
                <div><span>兑换时间</span><b>{activeRedeemHistory.usedAtBeijing || activeRedeemHistory.usedAt || "未记录"}</b></div>
                <div><span>订单完成时间</span><b>{activeRedeemHistory.order?.completedAtBeijing || "未完成或无订单"}</b></div>
                <div><span>用户 IP</span><b>{activeRedeemHistory.usedIp || "未记录"}</b></div>
              </div>
              <div className="admin-mail-detail-content">
                <span>用户订单输入内容</span>
                {activeRedeemHistory.order?.inputs?.length ? (
                  <div className="admin-redeem-input-list">
                    {activeRedeemHistory.order.inputs.map((item, index) => (
                      <div key={`${item.label}-${index}`}>
                        <strong>{item.label}</strong>
                        <p>{item.value}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>无额外输入内容</p>
                )}
              </div>
              <div className="admin-mail-detail-actions">
                <button type="button" onClick={() => copyText(activeRedeemHistory.code)}><Copy size={12} />复制兑换码</button>
                <button type="button" onClick={() => openPdfRemarkModal("redeem", activeRedeemHistory)}><Download size={12} />导出 PDF</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeCodeBatch && (
        <div className="admin-modal-mask" onClick={() => !codeBusy && setActiveCodeBatch(null)}>
          <div className="admin-modal admin-code-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">{activeCodeBatch.type === "service" ? "服务码批次" : "余额码批次"}</div>
                <div className="admin-modal-status status-received">{activeCodeBatch.createdAtBeijing || activeCodeBatch.createdAt}</div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => setActiveCodeBatch(null)} disabled={!!codeBusy}><X size={16} /></button>
            </div>
            <div className="admin-modal-body">
              <div className="admin-code-batch-summary">
                <span>{activeCodeBatch.remark || "无备注"}</span>
                <b>{activeCodeBatch.type === "service" ? (activeCodeBatch.services || []).map((s) => s.label).join(" + ") : `¥${Number(activeCodeBatch.amount || 0).toFixed(2)}`}</b>
                <small>可用 {activeCodeBatch.counts?.active || 0} · 作废 {activeCodeBatch.counts?.void || 0} · 生成 #{activeCodeBatch.createdByStaffId || 1}</small>
              </div>
              <div className="admin-code-batch-actions">
                {canManageCodes && <button type="button" onClick={() => copyText((activeCodeBatch.codes || []).map((c) => c.code).join("\n"))}><Copy size={12} />复制全部</button>}
                {canManageCodes && <button type="button" onClick={() => batchCodeAction(activeCodeBatch.id, "void")} disabled={!!codeBusy}><AlertTriangle size={12} />全部作废</button>}
                {canDeleteRecords && (
                  <button type="button" className="danger" onClick={() => batchCodeAction(activeCodeBatch.id, "delete")} disabled={!!codeBusy}><Trash2 size={12} />删除批次</button>
                )}
              </div>
              <div className="admin-code-chip-grid">
                {(activeCodeBatch.codes || []).map((c) => (
                  <div key={c.code} className={`admin-code-chip status-${c.status}`}>
                    <button type="button" className="admin-code-chip-main" onClick={() => copyText(c.code)}>
                      <strong>{c.code}</strong>
                      <small>{c.status === "active" ? "可兑换" : c.status === "used" ? "已使用" : "已作废"}{c.usedBy ? ` · ${c.usedBy}` : ""}{c.usedOrderId ? ` · ${c.usedOrderId}` : ""}</small>
                    </button>
                    {canSendRedeemCodes && (
                      <button
                        type="button"
                        className="send"
                        title="发送至邮箱"
                        disabled={c.status !== "active"}
                        onClick={() => {
                          setSendCodeModal({ code: c.code, type: c.type || activeCodeBatch.type, label: activeCodeBatch.type === "service"
                            ? (activeCodeBatch.services || []).map((s) => s.label).join(" + ")
                            : `¥${Number(activeCodeBatch.amount || 0).toFixed(2)}` });
                          setSendCodeEmail("");
                          setSendCodeResult(null);
                        }}
                      >发</button>
                    )}
                    {canManageCodes && <button type="button" disabled={c.status !== "active" || !!codeBusy} onClick={() => codeActionV2(c.code, "void")}>废</button>}
                    {canDeleteRecords && (
                      <button type="button" className="danger" disabled={!!codeBusy} onClick={() => codeActionV2(c.code, "delete")}>删</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Send redeem code via email */}
      {sendCodeModal && (
        <div className="admin-modal-mask" onClick={() => !sendCodeBusy && setSendCodeModal(null)}>
          <div className="admin-confirm-modal admin-send-code-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-send-code-head">
              <Mail size={20} />
              <h3>发送兑换码到邮箱</h3>
              <button type="button" className="admin-modal-close" onClick={() => !sendCodeBusy && setSendCodeModal(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="admin-send-code-info">
              <div><span>兑换码</span><code>{sendCodeModal.code}</code></div>
              <div><span>{sendCodeModal.type === "service" ? "服务" : "金额"}</span><b>{sendCodeModal.label}</b></div>
            </div>
            <form className="admin-send-code-form" onSubmit={sendRedeemCodeEmail}>
              <label>
                <span>收件人邮箱</span>
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  value={sendCodeEmail}
                  onChange={(e) => { setSendCodeEmail(e.target.value); if (sendCodeResult?.type === "error") setSendCodeResult(null); }}
                  placeholder="customer@example.com"
                  required
                  autoFocus
                  disabled={sendCodeBusy}
                />
              </label>
              {sendCodeResult && <div className={`admin-alert ${sendCodeResult.type}`}>{sendCodeResult.message}</div>}
              <div className="admin-send-code-actions">
                <button type="button" onClick={() => setSendCodeModal(null)} disabled={sendCodeBusy}>取消</button>
                <button type="submit" className="primary" disabled={sendCodeBusy}>
                  {sendCodeBusy ? <><LoaderCircle size={13} className="spin-icon" />发送中</> : <><Mail size={13} />发送</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Ban / delete user confirmation */}
      {confirmUserAction && (
        <div className="admin-modal-mask" onClick={() => !userActionBusy && setConfirmUserAction(null)}>
          <div className="admin-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-confirm-icon">
              {confirmUserAction.action === "delete" ? <Trash2 size={22} /> : <AlertTriangle size={22} />}
            </div>
            <h3>
              {confirmUserAction.action === "delete" && "删除该用户?"}
              {confirmUserAction.action === "ban" && "封禁该用户?"}
              {confirmUserAction.action === "unban" && "解除封禁?"}
            </h3>
            <p className="admin-confirm-email">{confirmUserAction.email}</p>
            <p className="admin-confirm-text">
              {confirmUserAction.action === "delete" && "用户记录、余额明细将被永久删除,无法恢复。订单数据保留"}
              {confirmUserAction.action === "ban" && "封禁后用户无法登录现有账户。可随时解除"}
              {confirmUserAction.action === "unban" && "解除后用户可正常登录使用账户"}
            </p>
            <div className="admin-confirm-actions">
              <button type="button" onClick={() => setConfirmUserAction(null)} disabled={userActionBusy}>取消</button>
              <button
                type="button"
                className={confirmUserAction.action === "delete" ? "danger" : confirmUserAction.action === "ban" ? "warn" : "primary"}
                onClick={executeUserAction}
                disabled={userActionBusy}
              >
                {userActionBusy ? <><LoaderCircle size={13} className="spin-icon" />处理中</> : "确认"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
