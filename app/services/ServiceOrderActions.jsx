"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { BookOpen, ShoppingBag, X } from "lucide-react";
import { getDefaultProductPlan, getProductPlan, getProductPlanOptions, localizePlan, useCatalogSync } from "../lib/store";
import { useLocale } from "../components/LocaleProvider";

// 轻量事件埋点（service_view / cta_click），失败静默，无隐私提示。
function trackEvent(name, slug, label) {
  if (typeof window === "undefined") return;
  try {
    fetch("/api/track", {
      method: "POST", credentials: "include", keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "event", name, meta: { slug: slug || "", label: label || "" } }),
    }).catch(() => {});
  } catch (e) {}
}

export default function ServiceOrderActions({ service, soldOut = {} }) {
  const { t, locale } = useLocale();
  const catalogVersion = useCatalogSync(); // 拉后台商品/价格/库存覆盖
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(() => {
    const def = getDefaultProductPlan(service?.key);
    if (!def || !soldOut?.[def]) return def;
    const firstAvail = getProductPlanOptions(service?.key).find((p) => !soldOut?.[p.id]);
    return firstAvail?.id || def;
  });
  // 价格/规格/库存以合并目录为准(catalogVersion 变化即重算);售罄 = 目录 soldOut 或服务端首屏传入。
  const planOptions = useMemo(() => getProductPlanOptions(service?.key), [service?.key, catalogVersion]);
  const productKey = service?.key || "";
  const quoteOnly = productKey === "proxy-pay";
  const guideHref = service?.guideSlug ? `/guides/${service.guideSlug}` : "/guides";
  const currentPlan = getProductPlan(productKey, selectedPlan) || planOptions[0] || null;
  const isSoldOut = (planId) => Boolean(planOptions.find((p) => p.id === planId)?.soldOut) || Boolean(soldOut?.[planId]);
  const allSoldOut = planOptions.length > 0 && planOptions.every((p) => isSoldOut(p.id));

  useEffect(() => {
    setMounted(true);
    if (productKey) trackEvent("service_view", productKey);
  }, [productKey]);

  // 库存在挂载后异步更新时，若当前所选规格变为售罄，自动改选第一个可用规格（避免停在死路上的售罄选项）。
  useEffect(() => {
    if (!allSoldOut && selectedPlan && isSoldOut(selectedPlan)) {
      const firstAvail = planOptions.find((p) => !isSoldOut(p.id));
      if (firstAvail) setSelectedPlan(firstAvail.id);
    }
  }, [soldOut]); // eslint-disable-line react-hooks/exhaustive-deps

  function checkoutWithPlan() {
    if (!productKey || !currentPlan || isSoldOut(currentPlan.id)) return;
    trackEvent("cta_click", productKey, currentPlan.id);
    const params = new URLSearchParams();
    params.set("items", productKey);
    params.set(`${productKey}Plan`, currentPlan.id);
    if (productKey === "rocket") params.set("rocketPlan", currentPlan.id);
    window.location.href = `/checkout?${params.toString()}`;
  }

  if (!service) return null;

  if (quoteOnly) {
    return (
      <div className="service-seo-actions">
        <button
          type="button"
          className="primary-btn"
          onClick={() => {
            trackEvent("cta_click", productKey, "quote");
            window.location.href = "/checkout?items=proxy-pay";
          }}
        >
          <ShoppingBag size={16} />{locale === "en" ? "Request a quote" : "提交代付需求"}
        </button>
        <Link href={guideHref} className="secondary-btn">
          <BookOpen size={16} />{locale === "en" ? "Buying guide" : "购买指南"}
        </Link>
      </div>
    );
  }

  const pickerModal = (
    <div className="modal-mask product-detail-mask service-order-mask" onClick={() => setPickerOpen(false)}>
      <div className="modal-card rocket-picker-modal service-order-picker-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t("svc.selectPlan")}>
        <div className="modal-head">
          <div className="modal-head-left">
            <img src={service.image} alt={service.title} className="modal-product-image" />
            <div>
              <div className="section-kicker">{t("svc.selectPlan")}</div>
              <div className="modal-title">{service.shortTitle} · {t("svc.selectPlan")}</div>
            </div>
          </div>
          <button className="close-btn" onClick={() => setPickerOpen(false)} aria-label={t("common.close")}>
            <X size={22} />
          </button>
        </div>

        <div className="shop-rocket-plan-picker compact" aria-label={locale === "en" ? `Select ${service.shortTitle} plan` : `选择${service.shortTitle}规格`}>
          {planOptions.map((rawPlan) => {
            const plan = localizePlan(productKey, rawPlan, locale);
            const optSoldOut = isSoldOut(plan.id);
            return (
            <button
              key={plan.id}
              type="button"
              disabled={optSoldOut}
              className={`shop-rocket-plan-option${currentPlan?.id === plan.id ? " selected" : ""}${optSoldOut ? " sold-out" : ""}`}
              onClick={() => { if (!optSoldOut) setSelectedPlan(plan.id); }}
            >
              <span>
                <strong>{plan.label}{optSoldOut ? ` · ${locale === "en" ? "Sold out" : "已售罄"}` : ""}</strong>
                <small>{plan.desc}</small>
              </span>
              <b>¥{plan.amount}<em>/{plan.unit || (locale === "en" ? "yr" : "年")}</em></b>
            </button>
            );
          })}
        </div>

        <div className="modal-actions rocket-picker-actions">
          <button className="primary-btn" onClick={checkoutWithPlan} disabled={currentPlan ? isSoldOut(currentPlan.id) : false}>
            <ShoppingBag size={16} />
            {currentPlan && isSoldOut(currentPlan.id) ? (locale === "en" ? "Sold out" : "已售罄") : t("svc.pickAndOrder")}
          </button>
          <Link href={guideHref} className="secondary-btn">
            <BookOpen size={16} />
            {locale === "en" ? "Buying guide" : "购买指南"}
          </Link>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="service-seo-actions">
        <button type="button" className="primary-btn" onClick={() => setPickerOpen(true)} disabled={allSoldOut}>
          <ShoppingBag size={16} />{allSoldOut ? (locale === "en" ? "Sold out" : "已售罄") : t("svc.orderNow")}
        </button>
        <Link href={guideHref} className="secondary-btn">
          <BookOpen size={16} />{locale === "en" ? "Buying guide" : "购买指南"}
        </Link>
      </div>

      {pickerOpen && mounted ? createPortal(pickerModal, document.body) : null}
    </>
  );
}
