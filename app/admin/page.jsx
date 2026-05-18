"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { PRODUCTS, ROCKET_PLANS, DEFAULT_ROCKET_PLAN } from "../lib/store";
import {
  ArrowLeft, ChevronDown, Copy, Eye, EyeOff,
  LoaderCircle, LogOut, Search, ShieldCheck,
  CheckCircle2, Clock, Inbox, X, AlertTriangle, Trash2,
  Gift, CreditCard, Plus, UserPlus, Mail, BellRing, BarChart3, Download, FileText,
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
const WITHDRAWAL_STATUS = [
  ["pending", "待审核"],
  ["processing", "提现中"],
  ["success", "提现成功"],
  ["failed", "审核失败"],
];

function copyText(text) {
  if (typeof window === "undefined") return;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
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
        @media print {
          body { background: #fff !important; }
          .sheet { background: #fff !important; box-shadow: none; }
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
              <div class="name">冒央会社 · Maoyang Taiwan Inc</div>
              <div class="site">网址:https://liumeiti.vip</div>
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
              <p>用于核对兑换码状态、订单信息、兑换时间与用户提交内容。</p>
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

          <div class="foot">Copyright © 2020-2026 Maoyang Taiwan Inc. All rights reserved</div>
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
        @media print {
          body { background: #fff !important; }
          .sheet { background: #fff !important; box-shadow: none; }
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
              <div class="name">冒央会社 · Maoyang Taiwan Inc</div>
              <div class="site">网址:https://liumeiti.vip</div>
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

          <div class="foot">Copyright © 2020-2026 Maoyang Taiwan Inc. All rights reserved</div>
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
    description: "用于核对兑换码状态、订单信息、兑换时间与用户提交内容。",
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
    description: "用于核对订单状态、付款信息、用户资料与商品配置。",
    stamp: order.status === "completed" ? "已完成" : order.status === "invalid" ? "无效" : "已收到",
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

export default function AdminPage() {
  const [authed, setAuthed] = useState(null); // null=loading, false=login, true=ok
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [currentStaff, setCurrentStaff] = useState(null);
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
  const [tab, setTab] = useState("overview"); // "overview" | "orders" | "users" | "balance" | "staff"
  const [confirmUserAction, setConfirmUserAction] = useState(null); // { email, action: "ban" | "unban" | "delete" }
  const [userActionBusy, setUserActionBusy] = useState(false);
  const [userInfo, setUserInfo] = useState(null); // {user, transactions}
  const [userModalOpen, setUserModalOpen] = useState(false);
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
  const [activeRedeemHistory, setActiveRedeemHistory] = useState(null);
  const [pdfExportModal, setPdfExportModal] = useState(null); // { type: "redeem" | "order", record, note }
  const [sendCodeModal, setSendCodeModal] = useState(null); // { code, type, label } | null
  const [sendCodeEmail, setSendCodeEmail] = useState("");
  const [sendCodeBusy, setSendCodeBusy] = useState(false);
  const [sendCodeResult, setSendCodeResult] = useState(null);
  const [staffPane, setStaffPane] = useState({ staff: [], actions: [] });
  const [staffForm, setStaffForm] = useState({ username: "", password: "", remark: "" });
  const [staffBusy, setStaffBusy] = useState("");
  const [staffResult, setStaffResult] = useState(null);
  const [mailLogs, setMailLogs] = useState([]);
  const [mailSearch, setMailSearch] = useState("");
  const [mailForm, setMailForm] = useState({ to: "", subject: "客服服务通知", content: "" });
  const [mailLoading, setMailLoading] = useState(false);
  const [mailBusy, setMailBusy] = useState(false);
  const [mailResult, setMailResult] = useState(null);
  const [mailBatchMode, setMailBatchMode] = useState(false);
  const [selectedMailIds, setSelectedMailIds] = useState(new Set());
  const [mailDeleteBusy, setMailDeleteBusy] = useState(false);
  const [mailComposeOpen, setMailComposeOpen] = useState(false);
  const [activeMailLog, setActiveMailLog] = useState(null);
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [newOrderAlert, setNewOrderAlert] = useState(null);
  const [highlightOrderIds, setHighlightOrderIds] = useState(new Set());
  const overviewRef = useRef(null);

  const isRootStaff = Boolean(currentStaff?.root || Number(currentStaff?.id || 0) === 1);

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
        if (data.currentStaff) setCurrentStaff(data.currentStaff);
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
  }, [triggerNewOrderNotice]);

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
        if (data.currentStaff) setCurrentStaff(data.currentStaff);
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

  const loadWithdrawals = useCallback(async () => {
    setWithdrawalLoading(true);
    try {
      const res = await fetch("/api/admin/withdrawals", { credentials: "same-origin" });
      if (res.status === 401) { setAuthed(false); return; }
      const data = await res.json();
      if (data.ok) {
        if (data.currentStaff) setCurrentStaff(data.currentStaff);
        setWithdrawals(data.withdrawals || []);
      }
    } catch (e) {} finally {
      setWithdrawalLoading(false);
    }
  }, []);

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
      if (data.ok) setRedeemHistory(data.history || []);
    } catch (e) {} finally {
      setRedeemHistoryLoading(false);
    }
  }, []);

  const loadStaff = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/staff", { credentials: "same-origin" });
      if (res.status === 401) { setAuthed(false); return; }
      const data = await res.json();
      if (data.ok) {
        setCurrentStaff({ id: data.currentStaffId, root: data.currentStaffRoot });
        setStaffPane({ staff: data.staff || [], actions: data.actions || [] });
      }
    } catch (e) {}
  }, []);

  const loadMailLogs = useCallback(async () => {
    setMailLoading(true);
    try {
      const res = await fetch("/api/admin/mail", { credentials: "same-origin" });
      if (res.status === 401) { setAuthed(false); return; }
      const data = await res.json();
      if (data.ok) {
        if (data.currentStaff) setCurrentStaff(data.currentStaff);
        setMailLogs(data.logs || []);
      }
    } catch (e) {} finally {
      setMailLoading(false);
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

  // Load user list when entering users tab; load global log on balance tab
  useEffect(() => {
    if (!authed) return;
    if (tab === "users") loadAllUsers(userListQuery);
    if (tab === "balance") loadGlobalLog(logQuery, logFilter, logSource);
    if (tab === "withdrawals") loadWithdrawals();
    if (tab === "codes") {
      loadCodes();
      loadRedeemHistory(redeemHistoryQuery);
    }
    if (tab === "mail") loadMailLogs();
    if (tab === "staff") {
      if (isRootStaff) loadStaff();
      else if (currentStaff) setTab("orders");
    }
  }, [authed, tab, loadGlobalLog, loadAllUsers, loadWithdrawals, loadCodes, loadRedeemHistory, loadMailLogs, loadStaff, logFilter, logSource, isRootStaff, currentStaff?.id]);

  useEffect(() => {
    if (!authed) return;
    loadOverview();
  }, [authed, loadOverview]);

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
      if (action === "delete" && !isRootStaff) {
        setUserError("仅主账号可删除用户");
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
        setUserModalOpen(true);
      } else {
        setUserInfo(null);
        setUserModalOpen(false);
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
    if (!isRootStaff || withdrawalDeleteBusy || selectedWithdrawalIds.size === 0) return;
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
    if (!isRootStaff || logDeleteBusy || selectedLogIds.size === 0) return;
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

  async function sendCustomerMail(e) {
    e.preventDefault();
    if (mailBusy) return;
    setMailBusy(true);
    setMailResult(null);
    try {
      const res = await fetch("/api/admin/mail", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mailForm),
      });
      const data = await res.json();
      if (data.ok) {
        const sentCount = Number(data.sentCount || 1);
        const failedCount = Number(data.failedCount || 0);
        setMailForm((current) => ({ ...current, to: "", content: "" }));
        setMailComposeOpen(false);
        setMailResult({
          type: failedCount > 0 ? "error" : "success",
          message: failedCount > 0
            ? `已发送 ${sentCount} 封，${failedCount} 封失败，请查看发信记录`
            : `邮件已发送 ${sentCount} 封，并已记录工作人员编号`,
        });
        await loadMailLogs();
      } else {
        const msg = {
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
    if (!isRootStaff || mailDeleteBusy || selectedMailIds.size === 0) return;
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

  async function createCode(e) {
    e.preventDefault();
    if (codeBusy) return;
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
        if (codeType === "service") setCodeServices([]);
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
      // For rocket, only one plan can be selected at a time per service code
      if (target.key === "rocket") {
        return [...list.filter((s) => s.key !== "rocket"), target];
      }
      return [...list, target];
    });
  }

  async function codeAction(code, action) {
    if (codeBusy) return;
    if (action === "delete" && !isRootStaff) {
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
    if (action === "delete" && !isRootStaff) {
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
    if (action === "delete" && !isRootStaff) {
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
        setStaffPane({ staff: data.staff || [], actions: data.actions || [] });
        setStaffForm({ username: "", password: "", remark: "" });
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
        setStaffPane({ staff: data.staff || [], actions: data.actions || [] });
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

  // Try fetching orders to detect if authed
  const loadOrders = useCallback(async (q, status, options = {}) => {
    const silent = Boolean(options.silent);
    if (!silent) setLoading(true);
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
        if (data.currentStaff) setCurrentStaff(data.currentStaff);
        setAuthed(true);
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOrders(appliedSearch, filterStatus);
  }, [loadOrders, appliedSearch, filterStatus]);

  useEffect(() => {
    if (!authed || tab !== "orders") return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (activeOrder) return;
      loadOrders(appliedSearch, filterStatus, { silent: true });
    }, 10000);
    return () => clearInterval(timer);
  }, [authed, tab, activeOrder, loadOrders, appliedSearch, filterStatus]);

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
    if (target === "orders") {
      setTab("orders");
      setSearchInput("");
      setAppliedSearch("");
      setFilterStatus("received");
      loadOrders("", "received", { silent: true });
      return;
    }
    if (target === "withdrawals") {
      setTab("withdrawals");
      return;
    }
    if (target === "codes") {
      setTab("codes");
      return;
    }
    if (target === "mail") {
      setTab("mail");
      return;
    }
    if (target === "users") {
      setTab("users");
    }
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
        body: JSON.stringify({ username: loginName, password }),
      });
      const data = await res.json();
      if (data.ok) {
        setAuthed(true);
        setCurrentStaff(data.staff || null);
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
        loadOverview({ silent: true });
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
              required
            />
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

  const mailSearchText = mailSearch.trim().toLowerCase();
  const visibleMailLogs = mailSearchText
    ? mailLogs.filter((item) => String(item.to || "").toLowerCase().includes(mailSearchText))
    : mailLogs;

  // ── Dashboard ──
  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-left">
          <Link href="/"><img src="/logo.png" alt="冒央会社" className="admin-logo" /></Link>
          <span className="admin-tag">工作后台{currentStaff?.id ? ` · #${currentStaff.id}` : ""}</span>
        </div>
        <button type="button" className="admin-logout" onClick={doLogout}>
          <LogOut size={14} />退出
        </button>
      </header>

      <main className="admin-main">
        <div className="admin-tabs">
          <button type="button" className={`admin-tab-btn${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>状态总览</button>
          <button type="button" className={`admin-tab-btn${tab === "orders" ? " active" : ""}`} onClick={() => setTab("orders")}>
            订单管理{Number(overview?.pendingOrders || 0) > 0 && <em className="admin-tab-badge">{overview.pendingOrders}</em>}
          </button>
          <button type="button" className={`admin-tab-btn${tab === "users" ? " active" : ""}`} onClick={() => setTab("users")}>用户管理</button>
          <button type="button" className={`admin-tab-btn${tab === "withdrawals" ? " active" : ""}`} onClick={() => setTab("withdrawals")}>
            提现审核{Number(overview?.pendingWithdrawals || 0) > 0 && <em className="admin-tab-badge">{overview.pendingWithdrawals}</em>}
          </button>
          <button type="button" className={`admin-tab-btn${tab === "codes" ? " active" : ""}`} onClick={() => setTab("codes")}>兑换码</button>
          <button type="button" className={`admin-tab-btn${tab === "balance" ? " active" : ""}`} onClick={() => setTab("balance")}>余额变动</button>
          <button type="button" className={`admin-tab-btn${tab === "mail" ? " active" : ""}`} onClick={() => setTab("mail")}>客服发信</button>
          {isRootStaff && <button type="button" className={`admin-tab-btn${tab === "staff" ? " active" : ""}`} onClick={() => setTab("staff")}>工作人员</button>}
        </div>

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
                {overviewLoading && <LoaderCircle size={12} className="spin-icon" />}
              </div>
              <button type="button" className="admin-overview-item urgent" onClick={() => openOverviewTarget("orders")}>
                <span>待处理订单</span>
                <b>{overview?.pendingOrders ?? 0}</b>
              </button>
              <button type="button" className="admin-overview-item" onClick={() => openOverviewTarget("withdrawals")}>
                <span>待审核提现</span>
                <b>{overview?.pendingWithdrawals ?? 0}</b>
              </button>
              <button type="button" className="admin-overview-item" onClick={() => openOverviewTarget("codes")}>
                <span>可用兑换码</span>
                <b>{overview?.activeCodes ?? 0}</b>
              </button>
              <button type="button" className="admin-overview-item" onClick={() => openOverviewTarget("mail")}>
                <span>失败邮件</span>
                <b>{overview?.failedMails ?? 0}</b>
              </button>
              <button type="button" className="admin-overview-item" onClick={() => openOverviewTarget("users")}>
                <span>注册用户</span>
                <b>{overview?.usersTotal ?? 0}</b>
              </button>
              <div className="admin-overview-mini">
                <span>今日订单</span>
                <b>{overview?.todayOrders ?? 0}</b>
              </div>
              <div className="admin-overview-mini money">
                <span>今日营收</span>
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
              <div className="admin-overview-latest">
                <span>最新订单</span>
                <b>{overview?.latestOrderEmail || "暂无"}</b>
                {overview?.latestOrderService && <small>{overview.latestOrderService}</small>}
              </div>
            </div>
          </div>
        ) : tab === "users" ? (
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
                  <div key={u.email} className={`admin-userlist-item${u.banned ? " banned" : ""}`}>
                    <button
                      type="button"
                      className="admin-userlist-main"
                      onClick={() => loadUser(u.email)}
                    >
                      <span className="admin-userlist-name">
                        {u.username || "—"}
                        {u.banned && <em className="admin-userlist-banned">已封禁</em>}
                      </span>
                      <span className="admin-userlist-email">{u.email}</span>
                      <span className="admin-userlist-balance">¥{u.balance.toFixed(2)}</span>
                    </button>
                    <div className="admin-userlist-actions">
                      <button
                        type="button"
                        className="admin-userlist-action ban"
                        title={u.banned ? "解除封禁" : "封禁账户"}
                        onClick={() => setConfirmUserAction({ email: u.email, action: u.banned ? "unban" : "ban" })}
                      >{u.banned ? "解禁" : "封禁"}</button>
                      {isRootStaff && (
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
                  {isRootStaff && (
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
                  <div className="admin-code-history-list">
                    {redeemHistoryLoading ? (
                      <div className="admin-userlist-empty">加载中...</div>
                    ) : redeemHistory.length === 0 ? (
                      <div className="admin-userlist-empty">暂无兑换历史</div>
                    ) : redeemHistory.map((item) => (
                      <button
                        key={item.code}
                        type="button"
                        className="admin-code-history-item"
                        onClick={() => setActiveRedeemHistory(item)}
                      >
                        <span>
                          <strong>{item.code}</strong>
                        </span>
                        <span>
                          <b>{item.usedBy || item.order?.email || "未记录邮箱"}</b>
                        </span>
                      </button>
                    ))}
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
                  {PRODUCTS.flatMap((p) => {
                    if (p.key === "rocket") {
                      return Object.values(ROCKET_PLANS).map((plan) => {
                        const selected = codeServices.some((s) => {
                          const sk = typeof s === "string" ? s : s.key;
                          const sp = typeof s === "string" ? "" : (s.plan || "");
                          return sk === "rocket" && sp === plan.id;
                        });
                        return (
                          <button
                            key={`rocket-${plan.id}`}
                            type="button"
                            className={selected ? "selected" : ""}
                            onClick={() => toggleCodeService({ key: "rocket", plan: plan.id })}
                          >
                            <img src={p.image} alt="" />
                            <span>{p.title}</span>
                            <em className="admin-code-service-plan-tag">{plan.label} ¥{plan.amount}</em>
                          </button>
                        );
                      });
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
                    <em>可用 {batch.counts?.active || 0} · 已用 {batch.counts?.used || 0} · 作废 {batch.counts?.void || 0}</em>
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
                    <button type="button" disabled={c.status !== "active"} onClick={() => codeAction(c.code, "void")}>作废</button>
                    {isRootStaff && (
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
            <div className="admin-mail-compose-card">
              <div className="admin-card-title"><Mail size={15} />客服发信</div>
              <button type="button" onClick={() => { setMailResult(null); setMailComposeOpen(true); }}>
                <Mail size={13} />写邮件
              </button>
            </div>

            {mailResult && <div className={`admin-alert ${mailResult.type}`}>{mailResult.message}</div>}

            <div className="admin-mail-log">
              <div className="admin-userlist-head">
                <h3>发信记录 <em>{visibleMailLogs.length}{mailSearchText ? ` / ${mailLogs.length}` : ""}</em></h3>
                <div className="admin-inline-actions">
                  {isRootStaff && (
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
                  <div className="admin-userlist-empty">{mailLoading ? "加载中..." : "暂无发信记录"}</div>
                ) : visibleMailLogs.map((item) => {
                  const selected = selectedMailIds.has(item.id);
                  const ok = item.ok !== false;
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
                    <strong>{item.username}</strong>
                    <small>{item.root ? "环境变量主账号" : (item.remark || "无备注")} · {item.createdAtBeijing || ""}</small>
                  </span>
                  {!item.root && (
                    <button type="button" className="admin-userlist-action delete" onClick={() => deleteStaff(item.id)} disabled={staffBusy === "delete" + item.id}>
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              ))}
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
                {isRootStaff && (
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
              const isNew = highlightOrderIds.has(o.orderId);
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
                        <span className={`admin-order-status status-${o.status}`}>
                          {o.status === "completed" ? <CheckCircle2 size={11} /> : o.status === "invalid" ? <AlertTriangle size={11} /> : <Clock size={11} />}
                          {STATUS_LABEL[o.status]}
                        </span>
                      </span>
                    </div>
                    <div className="admin-order-mid">
                      <span className="admin-order-service">{o.serviceLabel}</span>
                      {o.itemCount > 1 && <span className="admin-order-count">{o.itemCount} 件</span>}
                    </div>
                    <div className="admin-order-bot">
                      <span className="admin-order-paid">
                        {o.paidCurrency === "CODE" ? "兑换码" : o.paidCurrency === "USDT" ? `${o.paidAmount} USDT` : `¥${o.paidAmount}`}
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
                  <div><span>支付方式</span><b>{activeOrder.paymentMethod === "redeem" ? "服务兑换码" : activeOrder.paymentMethod === "usdt" ? "USDT-TRC20" : "支付宝"}</b></div>
                  <div><span>实付金额</span><b>{activeOrder.paidCurrency === "CODE" ? "兑换码抵扣" : activeOrder.paidCurrency === "USDT" ? `${activeOrder.paidAmount} USDT` : `¥${activeOrder.paidAmount}`}</b></div>
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
                  {activeOrder.staffAudit?.[0] && (
                    <div className="span-2"><span>最近操作</span><b>{activeOrder.staffAudit[0].label || `#${activeOrder.staffAudit[0].staffId}`} · {activeOrder.staffAudit[0].createdAtBeijing}</b></div>
                  )}
                </div>
              </section>

              {/* Items */}
              <section className="admin-modal-section">
                <h3>商品配置 · {editForm.items.length} 件</h3>
                {editForm.items.map((it, idx) => {
                  const isRocket = it.service === "rocket";
                  const isSpotify = it.service === "spotify";
                  const isStaffFill = !isSpotify && !isRocket; // netflix/disney/max
                  return (
                    <div key={idx} className="admin-item-card">
                      <div className="admin-item-head">
                        <strong>{idx + 1}. {it.label}</strong>
                        {!isRocket && (
                          <span className="admin-item-tag">{isStaffFill ? "客服填写账号密码" : "可修改买家输入"}</span>
                        )}
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
        <div className="admin-modal-mask" onClick={() => !mailBusy && setMailComposeOpen(false)}>
          <div className="admin-modal admin-compact-modal admin-mail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">客服发信</div>
                <div className="admin-modal-status status-received">冒央会社客服人员</div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => setMailComposeOpen(false)} disabled={mailBusy}><X size={16} /></button>
            </div>
            <div className="admin-modal-body">
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
                <div className="admin-mail-helper">
                  <span>多个邮箱用英文逗号隔开</span>
                  <span>自动加入客服开头与结尾</span>
                  <span>正文保留换行</span>
                </div>
                <button type="submit" disabled={mailBusy}>
                  {mailBusy ? <LoaderCircle size={12} className="spin-icon" /> : <Mail size={12} />}
                  {mailBusy ? "发送中" : "发送邮件"}
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

      {userModalOpen && userInfo && (
        <div className="admin-modal-mask" onClick={() => !balBusy && setUserModalOpen(false)}>
          <div className="admin-modal admin-compact-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-head">
              <div>
                <div className="admin-modal-id">{userInfo.user.username || "用户详情"}</div>
                <div className="admin-modal-status status-received">余额 ¥{userInfo.user.balance.toFixed(2)}</div>
              </div>
              <button type="button" className="admin-modal-close" onClick={() => setUserModalOpen(false)} disabled={balBusy}><X size={16} /></button>
            </div>
            <div className="admin-modal-body">
              <div className="admin-user-card">
                <div className="admin-user-head">
                  <span className="admin-user-email">{userInfo.user.email}</span>
                  <span className="admin-user-balance">¥{userInfo.user.balance.toFixed(2)}</span>
                </div>
                <div className="admin-user-meta">注册于 {userInfo.user.createdAtBeijing || "--"}</div>
              </div>
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
              <div className="admin-tx-list">
                <div className="admin-tx-list-label">余额明细 · {userInfo.transactions.length} 条</div>
                {userInfo.transactions.map((tx) => (
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
                <small>可用 {activeCodeBatch.counts?.active || 0} · 已用 {activeCodeBatch.counts?.used || 0} · 作废 {activeCodeBatch.counts?.void || 0} · 生成 #{activeCodeBatch.createdByStaffId || 1}</small>
              </div>
              <div className="admin-code-batch-actions">
                <button type="button" onClick={() => copyText((activeCodeBatch.codes || []).map((c) => c.code).join("\n"))}><Copy size={12} />复制全部</button>
                <button type="button" onClick={() => batchCodeAction(activeCodeBatch.id, "void")} disabled={!!codeBusy}><AlertTriangle size={12} />全部作废</button>
                {isRootStaff && (
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
                    <button type="button" disabled={c.status !== "active" || !!codeBusy} onClick={() => codeActionV2(c.code, "void")}>废</button>
                    {isRootStaff && (
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
              {confirmUserAction.action === "delete" && "用户记录、余额明细将被永久删除,无法恢复。订单数据保留。"}
              {confirmUserAction.action === "ban" && "封禁后用户无法登录现有账户。可随时解除。"}
              {confirmUserAction.action === "unban" && "解除后用户可正常登录使用账户。"}
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
