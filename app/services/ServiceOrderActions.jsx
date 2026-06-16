"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Headphones, ShoppingBag, X } from "lucide-react";
import { getDefaultProductPlan, getProductPlan, getProductPlanOptions } from "../lib/store";
import { useLocale } from "../components/LocaleProvider";

export default function ServiceOrderActions({ service }) {
  const { t, locale } = useLocale();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(() => getDefaultProductPlan(service?.key));
  const planOptions = useMemo(() => getProductPlanOptions(service?.key), [service?.key]);
  const productKey = service?.key || "";
  const currentPlan = getProductPlan(productKey, selectedPlan) || planOptions[0] || null;

  useEffect(() => {
    setMounted(true);
  }, []);

  function checkoutWithPlan() {
    if (!productKey || !currentPlan) return;
    const params = new URLSearchParams();
    params.set("items", productKey);
    params.set(`${productKey}Plan`, currentPlan.id);
    if (productKey === "rocket") params.set("rocketPlan", currentPlan.id);
    window.location.href = `/checkout?${params.toString()}`;
  }

  if (!service) return null;

  const pickerModal = (
    <div className="modal-mask product-detail-mask service-order-mask" onClick={() => setPickerOpen(false)}>
      <div className="modal-card rocket-picker-modal service-order-picker-modal" onClick={(e) => e.stopPropagation()}>
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

        <div className="shop-rocket-plan-picker compact" aria-label={`选择${service.shortTitle}规格`}>
          {planOptions.map((plan) => (
            <button
              key={plan.id}
              type="button"
              className={`shop-rocket-plan-option${currentPlan?.id === plan.id ? " selected" : ""}`}
              onClick={() => setSelectedPlan(plan.id)}
            >
              <span>
                <strong>{plan.label}</strong>
                <small>{plan.desc}</small>
              </span>
              <b>¥{plan.amount}<em>/{plan.unit || (locale === "en" ? "yr" : "年")}</em></b>
            </button>
          ))}
        </div>

        <div className="modal-actions rocket-picker-actions">
          <button className="primary-btn" onClick={checkoutWithPlan}>
            <ShoppingBag size={16} />
            {t("svc.pickAndOrder")}
          </button>
          <Link href="/service-center#contact" className="secondary-btn">
            <Headphones size={16} />
            {t("svc.askSupport")}
          </Link>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="service-seo-actions">
        <button type="button" className="primary-btn" onClick={() => setPickerOpen(true)}>
          <ShoppingBag size={16} />{t("svc.orderNow")}
        </button>
        <Link href="/service-center#contact" className="secondary-btn">
          <Headphones size={16} />{t("svc.askSupport")}
        </Link>
      </div>

      {pickerOpen && mounted ? createPortal(pickerModal, document.body) : null}
    </>
  );
}
