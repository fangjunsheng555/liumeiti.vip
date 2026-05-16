"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { PRODUCTS, ROCKET_PLANS, DEFAULT_ROCKET_PLAN } from "../lib/store";
import {
  ArrowLeft, ChevronDown, Copy, Eye, EyeOff,
  LoaderCircle, LogOut, Search, ShieldCheck,
  CheckCircle2, Clock, Inbox, X, AlertTriangle, Trash2,
  Gift, CreditCard, Plus, UserPlus, Mail,
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

export default function AdminPage() {
  const [authed, setAuthed] = useState(null); // null=loading, false=login, true=ok
  const [loginName, setLoginName] = useState("admin");
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
  const [tab, setTab] = useState("orders"); // "orders" | "users" | "balance" | "staff"
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
  const [codeType, setCodeType] = useState("balance");
  const [codeAmount, setCodeAmount] = useState("");
  const [codeQuantity, setCodeQuantity] = useState("1");
  const [codeRemark, setCodeRemark] = useState("");
  const [codeCustom, setCodeCustom] = useState("");
  const [codeServices, setCodeServices] = useState([]);
  const [codeBusy, setCodeBusy] = useState("");
  const [codeResult, setCodeResult] = useState(null);
  const [activeCodeBatch, setActiveCodeBatch] = useState(null);
  const [sendCodeModal, setSendCodeModal] = useState(null); // { code, type, label } | null
  const [sendCodeEmail, setSendCodeEmail] = useState("");
  const [sendCodeBusy, setSendCodeBusy] = useState(false);
  const [sendCodeResult, setSendCodeResult] = useState(null);
  const [staffPane, setStaffPane] = useState({ staff: [], actions: [] });
  const [staffForm, setStaffForm] = useState({ username: "", password: "", remark: "" });
  const [staffBusy, setStaffBusy] = useState("");
  const [staffResult, setStaffResult] = useState(null);
  const [mailLogs, setMailLogs] = useState([]);
  const [mailForm, setMailForm] = useState({ to: "", subject: "客服服务通知", content: "" });
  const [mailLoading, setMailLoading] = useState(false);
  const [mailBusy, setMailBusy] = useState(false);
  const [mailResult, setMailResult] = useState(null);
  const [mailBatchMode, setMailBatchMode] = useState(false);
  const [selectedMailIds, setSelectedMailIds] = useState(new Set());
  const [mailDeleteBusy, setMailDeleteBusy] = useState(false);
  const [mailComposeOpen, setMailComposeOpen] = useState(false);
  const [activeMailLog, setActiveMailLog] = useState(null);

  const isRootStaff = Boolean(currentStaff?.root || Number(currentStaff?.id || 0) === 1);

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
    if (tab === "codes") loadCodes();
    if (tab === "mail") loadMailLogs();
    if (tab === "staff") {
      if (isRootStaff) loadStaff();
      else if (currentStaff) setTab("orders");
    }
  }, [authed, tab, loadGlobalLog, loadAllUsers, loadWithdrawals, loadCodes, loadMailLogs, loadStaff, logFilter, logSource, isRootStaff, currentStaff?.id]);

  async function executeUserAction() {
    if (!confirmUserAction || userActionBusy) return;
    setUserActionBusy(true);
    try {
      const { email, action } = confirmUserAction;
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
        setMailForm((current) => ({ ...current, to: "", content: "" }));
        setMailComposeOpen(false);
        setMailResult({ type: "success", message: "邮件已发送，并已记录工作人员编号" });
        await loadMailLogs();
      } else {
        const msg = {
          invalid_email: "请填写正确的收件邮箱",
          content_required: "请填写邮件正文内容",
          smtp_or_to_missing: "SMTP 发信配置不完整",
          send_failed_after_retry: "邮件发送失败，请检查 SMTP 配置或稍后重试",
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
        if (data.currentStaff) setCurrentStaff(data.currentStaff);
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
              type="text"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              placeholder="工作人员账号"
              autoComplete="username"
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
          <button type="button" className={`admin-tab-btn${tab === "orders" ? " active" : ""}`} onClick={() => setTab("orders")}>订单管理</button>
          <button type="button" className={`admin-tab-btn${tab === "users" ? " active" : ""}`} onClick={() => setTab("users")}>用户管理</button>
          <button type="button" className={`admin-tab-btn${tab === "withdrawals" ? " active" : ""}`} onClick={() => setTab("withdrawals")}>提现审核</button>
          <button type="button" className={`admin-tab-btn${tab === "codes" ? " active" : ""}`} onClick={() => setTab("codes")}>兑换码</button>
          <button type="button" className={`admin-tab-btn${tab === "balance" ? " active" : ""}`} onClick={() => setTab("balance")}>余额变动</button>
          <button type="button" className={`admin-tab-btn${tab === "mail" ? " active" : ""}`} onClick={() => setTab("mail")}>客服发信</button>
          {isRootStaff && <button type="button" className={`admin-tab-btn${tab === "staff" ? " active" : ""}`} onClick={() => setTab("staff")}>工作人员</button>}
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
                      <button
                        type="button"
                        className="admin-userlist-action delete"
                        title="删除账户"
                        onClick={() => setConfirmUserAction({ email: u.email, action: "delete" })}
                      ><Trash2 size={11} /></button>
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
            <form className="admin-code-form" onSubmit={createCode}>
              <div className="admin-card-title"><Gift size={15} />生成兑换码</div>
              <div className="admin-code-type-toggle">
                <button type="button" className={codeType === "balance" ? "active" : ""} onClick={() => setCodeType("balance")}>余额码</button>
                <button type="button" className={codeType === "service" ? "active" : ""} onClick={() => setCodeType("service")}>服务码</button>
              </div>
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
            </form>
            {codeResult && <div className={`admin-alert ${codeResult.type}`}>{codeResult.message}</div>}
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
                    <button type="button" className="danger" onClick={() => codeAction(c.code, "delete")}><Trash2 size={11} />删除</button>
                  </div>
                </div>
              ))}
            </div>
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
                <h3>发信记录 <em>{mailLogs.length}</em></h3>
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
                          <button type="button" className="admin-filter-btn" onClick={() => setSelectedMailIds(new Set(mailLogs.map((item) => item.id).filter(Boolean)))}>全选</button>
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
              <div className="admin-mail-log-list">
                {mailLogs.length === 0 ? (
                  <div className="admin-userlist-empty">{mailLoading ? "加载中..." : "暂无发信记录"}</div>
                ) : mailLogs.map((item) => {
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
                      type="email"
                      inputMode="email"
                      value={mailForm.to}
                      onChange={(e) => setMailForm({ ...mailForm, to: e.target.value })}
                      placeholder="customer@example.com"
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
                <button type="button" className="danger" onClick={() => batchCodeAction(activeCodeBatch.id, "delete")} disabled={!!codeBusy}><Trash2 size={12} />删除批次</button>
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
                    <button type="button" className="danger" disabled={!!codeBusy} onClick={() => codeActionV2(c.code, "delete")}>删</button>
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
