"use client";

// 商品/价格/库存管理 — 仅超级管理员。读写 /api/admin/catalog。
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, History, ImageIcon, LoaderCircle,
  Package, RotateCcw, Save, Search, Undo2, X,
} from "lucide-react";
import { getCatalogDisplayPrice } from "../lib/catalog-price.js";
import { clientFetch as fetch } from "../lib/client-fetch";
import { beginLatestRequest, isLatestRequest } from "../lib/latest-request";

const PRODUCT_FIELDS = [
  "active", "sort", "title", "subtitle", "priceText", "shortIntro", "highlights",
  "cycle", "defaultPlan", "image", "detailTitle", "detailBody",
];
const PLAN_FIELDS = ["label", "cycle", "desc", "active"];

function priceDraftsFromCatalog(catalog) {
  const drafts = {};
  for (const product of catalog || []) {
    for (const plan of product.plans || []) drafts[`${product.key}:${plan.id}`] = String(plan.amount ?? "");
  }
  return drafts;
}

function isSafeImage(value) {
  const image = String(value || "").trim();
  if (!image || image.length > 500 || /[\u0000-\u001f\u007f\\]/.test(image)) return false;
  if (image.startsWith("/")) return !image.startsWith("//");
  try {
    const url = new URL(image);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function changeCount(catalog, baseline, priceDrafts, stockEdits) {
  if (!catalog || !baseline) return 0;
  const oldProducts = new Map(baseline.map((product) => [product.key, product]));
  let count = Object.keys(stockEdits).length;
  for (const product of catalog) {
    const oldProduct = oldProducts.get(product.key) || {};
    for (const field of PRODUCT_FIELDS) {
      if (JSON.stringify(product[field] ?? null) !== JSON.stringify(oldProduct[field] ?? null)) count += 1;
    }
    const oldPlans = new Map((oldProduct.plans || []).map((plan) => [plan.id, plan]));
    for (const plan of product.plans || []) {
      const oldPlan = oldPlans.get(plan.id) || {};
      for (const field of PLAN_FIELDS) {
        if (JSON.stringify(plan[field] ?? null) !== JSON.stringify(oldPlan[field] ?? null)) count += 1;
      }
      if (String(priceDrafts[`${product.key}:${plan.id}`] ?? "") !== String(oldPlan.amount ?? "")) count += 1;
    }
  }
  return count;
}

function localValidation(catalog, priceDrafts) {
  const errors = {};
  const normalized = (catalog || []).map((product) => {
    const plans = (product.plans || []).map((plan) => {
      const key = `${product.key}:${plan.id}`;
      const raw = String(priceDrafts[key] ?? "").trim();
      const amount = Number(raw);
      if (!product.quoteOnly && (!raw || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000 || !/^\d+(?:\.\d{1,2})?$/.test(raw))) {
        errors[`${product.key}.${plan.id}.amount`] = "价格须大于 0、不超过 1,000,000 元，且最多两位小数";
      }
      return { ...plan, amount: product.quoteOnly ? Number(plan.amount || 0) : amount };
    });
    if (!isSafeImage(product.image)) errors[`${product.key}.image`] = "图片地址仅支持站内 / 路径或 HTTPS 地址";
    const activePlans = plans.filter((plan) => plan.active !== false);
    if (product.active !== false && !product.quoteOnly && activePlans.length === 0) {
      errors[`${product.key}.plans`] = "上架商品至少需要一个上架规格";
    }
    if (!activePlans.some((plan) => plan.id === product.defaultPlan)) {
      errors[`${product.key}.defaultPlan`] = "默认规格必须选择当前已上架规格";
    }
    const next = { ...product, plans };
    return { ...next, priceText: getCatalogDisplayPrice(next) };
  });
  return { ok: Object.keys(errors).length === 0, errors, catalog: normalized };
}

export default function CatalogPanel({ onDirtyChange }) {
  const [catalog, setCatalog] = useState(null);
  const [baselineCatalog, setBaselineCatalog] = useState(null);
  const [priceDrafts, setPriceDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [msg, setMsg] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [stockEdits, setStockEdits] = useState({});
  const [currentVersion, setCurrentVersion] = useState("");
  const [versions, setVersions] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState("");
  const [search, setSearch] = useState("");
  const [openProducts, setOpenProducts] = useState(() => new Set());
  const loadRequestRef = useRef(0);
  const dirtyRef = useRef(false);

  const dirtyCount = useMemo(
    () => changeCount(catalog, baselineCatalog, priceDrafts, stockEdits),
    [catalog, baselineCatalog, priceDrafts, stockEdits],
  );
  const dirty = dirtyCount > 0;
  dirtyRef.current = dirty;
  const controlsBusy = saving || loading || loadFailed || historyLoading || Boolean(rollbackBusy);

  const load = useCallback(async ({ skipConfirm = false } = {}) => {
    if (!skipConfirm && dirtyRef.current && !window.confirm("当前有未保存修改，确定重载并放弃这些修改吗？")) return;
    const requestId = beginLatestRequest(loadRequestRef);
    setLoading(true);
    setMsg(null);
    try {
      const response = await fetch("/api/admin/catalog", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!isLatestRequest(loadRequestRef, requestId)) return;
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error === "unauthorized" ? "仅超级管理员可管理商品" : "商品目录加载失败，请重试");
      }
      if (!Array.isArray(data.catalog) || data.catalog.length === 0) {
        throw new Error("商品目录返回异常，请重试");
      }
      const nextCatalog = data.catalog;
      setCatalog(nextCatalog);
      setBaselineCatalog(structuredClone(nextCatalog));
      setPriceDrafts(priceDraftsFromCatalog(nextCatalog));
      setStockEdits({});
      setFieldErrors({});
      setLoadFailed(false);
      setCurrentVersion(data.currentVersion || "");
      setVersions(Array.isArray(data.versions) ? data.versions : []);
      setOpenProducts((current) => current.size ? current : new Set(nextCatalog.slice(0, 1).map((item) => item.key)));
    } catch (error) {
      if (isLatestRequest(loadRequestRef, requestId)) {
        setLoadFailed(true);
        setMsg({ type: "error", text: error?.message || "网络错误，请重试" });
      }
    } finally {
      if (isLatestRequest(loadRequestRef, requestId)) setLoading(false);
    }
  }, []);

  useEffect(() => { load({ skipConfirm: true }); }, [load]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    const beforeUnload = (event) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  function clearFieldError(key) {
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function patchProduct(key, field, value) {
    if (controlsBusy) return;
    clearFieldError(`${key}.${field}`);
    setCatalog((current) => current.map((product) => (product.key === key ? { ...product, [field]: value } : product)));
  }

  function patchPlan(key, planId, field, value) {
    if (controlsBusy) return;
    clearFieldError(`${key}.${planId}.${field}`);
    setCatalog((current) => current.map((product) => {
      if (product.key !== key) return product;
      const plans = product.plans.map((plan) => (plan.id === planId ? { ...plan, [field]: value } : plan));
      const nextDefault = field === "active" && value === false && product.defaultPlan === planId
        ? plans.find((plan) => plan.active !== false)?.id || ""
        : product.defaultPlan;
      return { ...product, plans, defaultPlan: nextDefault };
    }));
  }

  function setPriceDraft(product, plan, value) {
    if (controlsBusy) return;
    const key = `${product.key}:${plan.id}`;
    const cleaned = value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
    setPriceDrafts((current) => ({ ...current, [key]: cleaned }));
    clearFieldError(`${product.key}.${plan.id}.amount`);
  }

  const stockKey = (productKey, planId) => `${productKey}:${planId}`;
  function stockValue(product, plan) {
    const key = stockKey(product.key, plan.id);
    if (Object.hasOwn(stockEdits, key)) return stockEdits[key];
    return plan.stock == null ? "" : String(plan.stock);
  }

  function setStockValue(product, plan, value) {
    if (controlsBusy) return;
    const cleaned = value === "" ? "" : value.replace(/[^\d]/g, "");
    const original = plan.stock == null ? "" : String(plan.stock);
    setStockEdits((current) => {
      const next = { ...current };
      if (cleaned === original) delete next[stockKey(product.key, plan.id)];
      else next[stockKey(product.key, plan.id)] = cleaned;
      return next;
    });
  }

  function mapServerErrors(serverErrors) {
    const mapped = {};
    for (const [path, error] of Object.entries(serverErrors || {})) {
      const match = /^catalog\.(\d+)(?:\.plans\.(\d+))?\.(\w+)$/.exec(path);
      if (!match) continue;
      const product = catalog?.[Number(match[1])];
      const plan = match[2] == null ? null : product?.plans?.[Number(match[2])];
      const key = plan ? `${product.key}.${plan.id}.${match[3]}` : `${product?.key}.${match[3]}`;
      if (product) mapped[key] = error?.message || "请检查此字段";
    }
    return mapped;
  }

  async function save() {
    if (saving || loading || loadFailed || historyLoading || rollbackBusy) return;
    if (!dirty) return;
    const validation = localValidation(catalog, priceDrafts);
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      const firstKey = Object.keys(validation.errors)[0];
      if (firstKey) setOpenProducts((current) => new Set(current).add(firstKey.split(".")[0]));
      setMsg({ type: "error", text: "请先修正标记的商品或规格字段" });
      return;
    }
    const submittedStock = { ...stockEdits };
    setSaving(true);
    setMsg(null);
    try {
      const response = await fetch("/api/admin/catalog", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalog: validation.catalog, stockEdits: submittedStock, baseVersion: currentVersion }),
      });
      const data = await response.json();
      if (data?.ok === true) {
        const nextCatalog = data.catalog || validation.catalog;
        setCatalog(nextCatalog);
        setBaselineCatalog(structuredClone(nextCatalog));
        setPriceDrafts(priceDraftsFromCatalog(nextCatalog));
        setStockEdits({});
        setFieldErrors({});
        setCurrentVersion(data.currentVersion || currentVersion);
        if (data.version) setVersions((items) => [data.version, ...items].slice(0, 60));
        setMsg({ type: "ok", text: "已保存，前端展示、结账价格与库存已同步" });
      } else if (data?.catalogCommitted === true && Array.isArray(data.catalog)) {
        const failedKeys = new Set((data.failedStock || []).map((item) => stockKey(item.service, item.plan)));
        const failedEdits = Object.fromEntries(Object.entries(submittedStock).filter(([key]) => failedKeys.has(key)));
        setCatalog(data.catalog);
        setBaselineCatalog(structuredClone(data.catalog));
        setPriceDrafts(priceDraftsFromCatalog(data.catalog));
        setStockEdits(failedEdits);
        setFieldErrors({});
        setCurrentVersion(data.currentVersion || currentVersion);
        if (data.version) setVersions((items) => [data.version, ...items].slice(0, 60));
        setMsg({ type: "warning", text: `目录已发布但部分库存未更新，已保留 ${failedKeys.size} 项失败库存，请稍后重试保存` });
      } else if (response.status === 409 || data?.error === "version_conflict") {
        setMsg({ type: "error", text: "该目录已被其他后台页面修改。请重载最新版本后再重新编辑。", retry: true });
      } else {
        const serverErrors = mapServerErrors(data?.fieldErrors);
        if (Object.keys(serverErrors).length) setFieldErrors(serverErrors);
        setMsg({ type: "error", text: data?.message || (data?.error === "invalid_catalog" ? "请修正标记字段后再保存" : "保存失败，请重试") });
      }
    } catch {
      setMsg({ type: "error", text: "保存请求失败，请检查网络后重试" });
    } finally {
      setSaving(false);
    }
  }

  async function openHistory() {
    if (controlsBusy) return;
    if (dirty && !window.confirm("当前修改尚未保存，版本记录不会包含这些修改。仍要继续吗？")) return;
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const response = await fetch("/api/admin/catalog/versions", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data?.ok !== true) throw new Error("version_history_failed");
      setVersions(Array.isArray(data.versions) ? data.versions : []);
      setCurrentVersion(data.currentVersion || currentVersion);
    } catch {
      setMsg({ type: "error", text: "版本记录加载失败，请关闭后重试" });
    } finally {
      setHistoryLoading(false);
    }
  }

  async function rollback(version) {
    if (!version?.id || version.id === currentVersion || controlsBusy) return;
    if (!window.confirm(`恢复到版本 ${version.id}？实时库存不会回滚。`)) return;
    setRollbackBusy(version.id);
    setMsg(null);
    try {
      const response = await fetch("/api/admin/catalog/rollback", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId: version.id, baseVersion: currentVersion }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (response.status === 409 || data.error === "version_conflict") throw new Error("目录已被更新，请关闭记录后重载");
        throw new Error("版本恢复失败");
      }
      const nextCatalog = data.catalog || [];
      setCatalog(nextCatalog);
      setBaselineCatalog(structuredClone(nextCatalog));
      setPriceDrafts(priceDraftsFromCatalog(nextCatalog));
      setStockEdits({});
      setFieldErrors({});
      setCurrentVersion(data.currentVersion || currentVersion);
      if (data.version) setVersions((items) => [data.version, ...items].slice(0, 60));
      setHistoryOpen(false);
      setMsg({ type: "ok", text: "目录版本已恢复，实时库存保持不变" });
    } catch (error) {
      setMsg({ type: "error", text: error?.message || "版本恢复失败" });
    } finally {
      setRollbackBusy("");
    }
  }

  const visibleCatalog = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return catalog || [];
    return (catalog || []).filter((product) => [
      product.key, product.title, product.subtitle, product.shortIntro,
      ...(product.plans || []).flatMap((plan) => [plan.id, plan.label]),
    ].some((value) => String(value || "").toLowerCase().includes(keyword)));
  }, [catalog, search]);

  function toggleProduct(key) {
    setOpenProducts((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  if (loading && !catalog) return <div className="admin-catalog-loading"><LoaderCircle size={16} className="spin-icon" />正在加载商品目录…</div>;
  if (!catalog) return (
    <div className="admin-settings-alert error" role="alert">
      <AlertTriangle size={15} />{msg?.text || "商品目录加载失败"}
      <button type="button" className="admin-settings-btn" onClick={() => load({ skipConfirm: true })}><RotateCcw size={13} />重试加载</button>
    </div>
  );

  return (
    <div className="admin-settings admin-catalog" aria-busy={controlsBusy}>
      <div className="admin-settings-head admin-catalog-toolbar">
        <div className="admin-catalog-heading">
          <h2><Package size={19} />商品 / 价格管理</h2>
          <span className="sub">编辑前端商品信息、规格、价格与库存</span>
        </div>
        <span className="spacer" />
        <span className={`admin-catalog-dirty${dirty ? " active" : ""}`} aria-live="polite">{dirty ? `${dirtyCount} 项未保存` : "所有修改已保存"}</span>
        <button type="button" className="admin-settings-btn" onClick={openHistory} disabled={controlsBusy}><History size={13} />{historyLoading ? "加载记录" : "版本记录"}</button>
        <button type="button" className="admin-settings-btn" onClick={load} disabled={saving || loading || historyLoading || Boolean(rollbackBusy)}><RotateCcw size={13} />重载</button>
        <button type="button" className="admin-settings-btn primary" onClick={save} disabled={controlsBusy || !dirty}>
          {saving ? <LoaderCircle size={14} className="spin-icon" /> : <Save size={14} />}{saving ? "保存中" : "保存修改"}
        </button>
      </div>

      {msg && (
        <div className={`admin-settings-alert ${msg.type}`} role={msg.type === "ok" ? "status" : "alert"}>
          {msg.type === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{msg.text}
          {msg.retry && <button type="button" className="admin-settings-btn" onClick={() => load()}>重载最新目录</button>}
        </div>
      )}

      <label className="admin-catalog-search">
        <Search size={15} />
        <span className="sr-only">搜索商品或规格</span>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索商品名称、标识或规格…" disabled={controlsBusy} />
        <em>{visibleCatalog.length} / {catalog.length}</em>
      </label>

      {visibleCatalog.length === 0 ? <div className="admin-compact-empty">没有匹配的商品</div> : visibleCatalog.map((product) => {
        const expanded = openProducts.has(product.key);
        const activePlans = (product.plans || []).filter((plan) => plan.active !== false);
        const numericPrices = activePlans.map((plan) => Number(priceDrafts[stockKey(product.key, plan.id)])).filter((value) => value > 0);
        const displayPrice = product.quoteOnly ? product.priceText : numericPrices.length ? `¥${Math.min(...numericPrices)}` : "价格待修正";
        const productErrors = Object.entries(fieldErrors).filter(([key]) => key.startsWith(`${product.key}.`));
        return (
          <section key={product.key} className={`admin-catalog-card${product.active === false ? " inactive" : ""}${productErrors.length ? " has-error" : ""}`}>
            <div className="admin-catalog-card-head">
              <button type="button" className="admin-catalog-expand" onClick={() => toggleProduct(product.key)} aria-expanded={expanded} aria-controls={`catalog-${product.key}`}>
                <span className="admin-catalog-thumb">{isSafeImage(product.image) ? <img src={product.image} alt="" /> : <ImageIcon size={18} />}</span>
                <span className="admin-catalog-card-title"><strong>{product.title}</strong><small>{product.key}</small></span>
                <span className={`admin-catalog-state ${product.active === false ? "off" : "on"}`}>{product.active === false ? "已下架" : "上架中"}</span>
                <span className="admin-catalog-summary"><b>{displayPrice}</b><small>{product.plans?.length || 0} 个规格</small></span>
                {productErrors.length > 0 && <span className="admin-catalog-error-count">{productErrors.length} 处待修正</span>}
                <ChevronDown size={17} className={expanded ? "open" : ""} />
              </button>
              <label className="admin-settings-check admin-catalog-active">
                <input type="checkbox" checked={product.active !== false} onChange={(event) => patchProduct(product.key, "active", event.target.checked)} disabled={controlsBusy} />
                上架
              </label>
            </div>

            {expanded && (
              <fieldset id={`catalog-${product.key}`} className="admin-catalog-editor" disabled={controlsBusy}>
                <legend className="sr-only">编辑 {product.title}</legend>
                <div className="admin-settings-grid">
                  <label className="admin-settings-field"><span>商品名称</span><input value={product.title || ""} onChange={(event) => patchProduct(product.key, "title", event.target.value)} /></label>
                  <label className="admin-settings-field"><span>副标题</span><input value={product.subtitle || ""} onChange={(event) => patchProduct(product.key, "subtitle", event.target.value)} /></label>
                  <label className="admin-settings-field"><span>商品周期</span><input value={product.cycle || ""} onChange={(event) => patchProduct(product.key, "cycle", event.target.value)} placeholder="例如：1年" /></label>
                  <label className="admin-settings-field"><span>排序</span><input type="number" value={product.sort ?? 0} onChange={(event) => patchProduct(product.key, "sort", Number(event.target.value))} /></label>
                  <label className="admin-settings-field">
                    <span>{product.quoteOnly ? "报价展示文案" : "列表展示价（自动）"}</span>
                    <input value={product.priceText || ""} readOnly={!product.quoteOnly} onChange={product.quoteOnly ? (event) => patchProduct(product.key, "priceText", event.target.value) : undefined} />
                  </label>
                  <label className={`admin-settings-field${fieldErrors[`${product.key}.defaultPlan`] ? " invalid" : ""}`}>
                    <span>默认规格</span>
                    <select value={product.defaultPlan || ""} onChange={(event) => patchProduct(product.key, "defaultPlan", event.target.value)}>
                      <option value="" disabled>请选择已上架规格</option>
                      {activePlans.map((plan) => <option value={plan.id} key={plan.id}>{plan.label} · {plan.id}</option>)}
                    </select>
                    {fieldErrors[`${product.key}.defaultPlan`] && <em>{fieldErrors[`${product.key}.defaultPlan`]}</em>}
                  </label>
                  <label className="admin-settings-field full"><span>短简介</span><input value={product.shortIntro || ""} onChange={(event) => patchProduct(product.key, "shortIntro", event.target.value)} /></label>
                  <label className="admin-settings-field full"><span>卖点（使用 ｜ 分隔，最多 8 条）</span><input value={(product.highlights || []).join("｜")} onChange={(event) => patchProduct(product.key, "highlights", event.target.value.split("｜").map((item) => item.trim()).filter(Boolean))} /></label>
                  <label className={`admin-settings-field full${fieldErrors[`${product.key}.image`] ? " invalid" : ""}`}>
                    <span>商品图片</span>
                    <div className="admin-catalog-image-field">
                      <span className="admin-catalog-image-preview">{isSafeImage(product.image) ? <img src={product.image} alt={`${product.title} 图片预览`} /> : <ImageIcon size={22} />}</span>
                      <input value={product.image || ""} onChange={(event) => patchProduct(product.key, "image", event.target.value)} placeholder="/products/example.jpg 或 https://…" />
                    </div>
                    {fieldErrors[`${product.key}.image`] && <em>{fieldErrors[`${product.key}.image`]}</em>}
                  </label>
                  <label className="admin-settings-field full"><span>详情页标题（可选）</span><input value={product.detailTitle || ""} onChange={(event) => patchProduct(product.key, "detailTitle", event.target.value)} /></label>
                  <label className="admin-settings-field full"><span>详情页正文（可选）</span><textarea rows="3" value={product.detailBody || ""} onChange={(event) => patchProduct(product.key, "detailBody", event.target.value)} /></label>
                </div>

                {product.quoteOnly ? (
                  <div className="admin-settings-hint">人工报价商品由客服核价，不设置固定销售价格或库存。</div>
                ) : (
                  <div className="admin-catalog-plans">
                    <div className="admin-catalog-plans-title">规格、价格与库存 <span>库存留空 = 不限，0 = 售罄</span></div>
                    {fieldErrors[`${product.key}.plans`] && <div className="admin-catalog-inline-error">{fieldErrors[`${product.key}.plans`]}</div>}
                    {(product.plans || []).map((plan) => {
                      const stock = stockValue(product, plan);
                      const amountError = fieldErrors[`${product.key}.${plan.id}.amount`];
                      return (
                        <div key={plan.id} className={`admin-catalog-plan-row${amountError ? " invalid" : ""}`} data-inactive={plan.active === false ? "1" : undefined}>
                          <label className="plan-label"><span>规格名称</span><input value={plan.label || ""} onChange={(event) => patchPlan(product.key, plan.id, "label", event.target.value)} /></label>
                          <label className="plan-amount"><span>实收价</span><div><b>¥</b><input inputMode="decimal" value={priceDrafts[stockKey(product.key, plan.id)] ?? ""} onChange={(event) => setPriceDraft(product, plan, event.target.value)} aria-invalid={Boolean(amountError)} /></div>{amountError && <em>{amountError}</em>}</label>
                          <label className="plan-stock"><span>库存</span><input inputMode="numeric" placeholder="不限" value={stock} onChange={(event) => setStockValue(product, plan, event.target.value)} /></label>
                          <label className="plan-cycle"><span>周期</span><input value={plan.cycle || ""} onChange={(event) => patchPlan(product.key, plan.id, "cycle", event.target.value)} /></label>
                          <label className="plan-desc"><span>规格说明</span><input value={plan.desc || ""} onChange={(event) => patchPlan(product.key, plan.id, "desc", event.target.value)} /></label>
                          <label className="plan-active"><input type="checkbox" checked={plan.active !== false} onChange={(event) => patchPlan(product.key, plan.id, "active", event.target.checked)} />上架</label>
                        </div>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            )}
          </section>
        );
      })}

      {dirty && <div className="admin-catalog-savebar"><span><b>{dirtyCount}</b> 项修改尚未保存</span><button type="button" className="admin-settings-btn primary" onClick={save} disabled={controlsBusy}>{saving ? <LoaderCircle size={14} className="spin-icon" /> : <Save size={14} />}{saving ? "保存中" : "保存修改"}</button></div>}

      {historyOpen && (
        <div className="admin-drawer-mask" onMouseDown={(event) => event.target === event.currentTarget && !rollbackBusy && setHistoryOpen(false)}>
          <aside className="admin-compact-drawer admin-version-drawer" role="dialog" aria-modal="true" aria-label="商品目录版本记录">
            <header><div><span>商品目录</span><strong>版本记录</strong></div><button type="button" onClick={() => setHistoryOpen(false)} disabled={Boolean(rollbackBusy)} aria-label="关闭"><X size={18} /></button></header>
            <p className="admin-version-note">恢复价格、规格与商品文案；实时库存不会回滚。</p>
            <div className="admin-version-list">
              {historyLoading ? <div className="admin-compact-empty">版本记录加载中…</div> : versions.length === 0 ? <div className="admin-compact-empty">暂无版本记录</div> : versions.map((version) => {
                const current = version.id === currentVersion;
                const summary = version.summary || {};
                return <div className={`admin-version-row${current ? " current" : ""}`} key={version.id}><div><strong>{version.source === "rollback" ? "恢复版本" : version.source === "baseline" ? "初始版本" : "目录更新"}{current ? <em>当前</em> : null}</strong><small>{version.createdAtBeijing || version.createdAt}</small><span>{summary.productCount || 0} 个商品 · {summary.fieldCount || 0} 项变更 · {version.actor?.staffUsername || "system"}</span></div><button type="button" onClick={() => rollback(version)} disabled={current || controlsBusy}>{rollbackBusy === version.id ? <LoaderCircle size={13} className="spin-icon" /> : <Undo2 size={13} />}{current ? "使用中" : "恢复"}</button></div>;
              })}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
