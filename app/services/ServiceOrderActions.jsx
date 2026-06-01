"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Headphones, ShoppingBag, X } from "lucide-react";
import { getDefaultProductPlan, getProductPlan, getProductPlanOptions } from "../lib/store";

export default function ServiceOrderActions({ service }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(() => getDefaultProductPlan(service?.key));
  const planOptions = useMemo(() => getProductPlanOptions(service?.key), [service?.key]);
  const productKey = service?.key || "";
  const currentPlan = getProductPlan(productKey, selectedPlan) || planOptions[0] || null;

  function checkoutWithPlan() {
    if (!productKey || !currentPlan) return;
    const params = new URLSearchParams();
    params.set("items", productKey);
    params.set(`${productKey}Plan`, currentPlan.id);
    if (productKey === "rocket") params.set("rocketPlan", currentPlan.id);
    window.location.href = `/checkout?${params.toString()}`;
  }

  if (!service) return null;

  return (
    <>
      <div className="service-seo-actions">
        <button type="button" className="primary-btn" onClick={() => setPickerOpen(true)}>
          <ShoppingBag size={16} />立即下单
        </button>
        <Link href="/service-center#contact" className="secondary-btn">
          <Headphones size={16} />咨询客服
        </Link>
      </div>

      {pickerOpen && (
        <div className="modal-mask product-detail-mask" onClick={() => setPickerOpen(false)}>
          <div className="modal-card rocket-picker-modal service-order-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-head-left">
                <img src={service.image} alt={service.title} className="modal-product-image" />
                <div>
                  <div className="section-kicker">规格选择</div>
                  <div className="modal-title">{service.shortTitle} · 选择规格</div>
                </div>
              </div>
              <button className="close-btn" onClick={() => setPickerOpen(false)} aria-label="关闭">
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
                  <b>¥{plan.amount}<em>/{plan.unit || "年"}</em></b>
                </button>
              ))}
            </div>

            <div className="modal-actions rocket-picker-actions">
              <button className="primary-btn" onClick={checkoutWithPlan}>
                <ShoppingBag size={16} />
                选择规格并下单
              </button>
              <Link href="/service-center#contact" className="secondary-btn">
                <Headphones size={16} />
                联系在线客服
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
