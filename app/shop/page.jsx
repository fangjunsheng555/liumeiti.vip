"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Flame,
  Gift,
  Headphones,
  MessageCircleMore,
  ShoppingCart,
  Sparkles,
  Star,
  Tag,
  X,
} from "lucide-react";
import {
  PRODUCTS,
  ROCKET_PLANS,
  DEFAULT_ROCKET_PLAN,
  getRocketPlan,
  useCart,
  cartSubtotalCny,
  cartFinalCny,
  bundleDiscountLabel,
  copyText,
  productItemAmount,
} from "../lib/store";
import MobileNav from "../components/MobileNav";
import FloatingSupport from "../components/FloatingSupport";

const PRODUCT_PROMOS = {
  spotify: { badge: "热销 No.1", badgeIcon: Flame, originalPrice: 298, soldThisMonth: 1328 },
  netflix: { badge: "影视首选", badgeIcon: Star, originalPrice: 398, soldThisMonth: 956 },
  disney: { badge: "性价比之选", badgeIcon: Gift, originalPrice: 268, soldThisMonth: 612 },
  max: { badge: "影迷经典最爱", badgeIcon: Tag, originalPrice: 348, soldThisMonth: 487 },
  rocket: { badge: "必备工具", badgeIcon: Sparkles, originalPrice: 268, soldThisMonth: 1580 },
};

function serviceIcon(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default function ShopPage() {
  const [selectedKey, setSelectedKey] = useState(null);
  const [rocketPickerOpen, setRocketPickerOpen] = useState(false);
  const [rocketPlanChoice, setRocketPlanChoice] = useState(DEFAULT_ROCKET_PLAN);
  const [cartExpanded, setCartExpanded] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");
  const { cart, cartPlans, addToCart, removeFromCart } = useCart();

  const selectedProduct = useMemo(() => PRODUCTS.find((item) => item.key === selectedKey) || null, [selectedKey]);
  const cartItems = useMemo(() => cart.map((key) => PRODUCTS.find((p) => p.key === key)).filter(Boolean), [cart]);
  const cartCount = cartItems.length;
  const activeRocketPlanId = cart.includes("rocket")
    ? (cartPlans.rocket || DEFAULT_ROCKET_PLAN)
    : (ROCKET_PLANS[rocketPlanChoice] ? rocketPlanChoice : DEFAULT_ROCKET_PLAN);
  const planMap = { rocket: activeRocketPlanId };
  const subtotal = cartSubtotalCny(cartItems, planMap);
  const finalAmount = cartFinalCny(cartItems, planMap);
  const savings = subtotal - finalAmount;

  useEffect(() => {
    if (cartPlans.rocket && ROCKET_PLANS[cartPlans.rocket]) setRocketPlanChoice(cartPlans.rocket);
  }, [cartPlans.rocket]);

  function isInCart(key) {
    return cart.includes(key);
  }

  function handleCopy(value, key) {
    copyText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(""), 1600);
  }

  function goCheckout() {
    if (cartCount === 0) return;
    const params = new URLSearchParams();
    params.set("items", cartItems.map((item) => item.key).join(","));
    if (cart.includes("rocket")) params.set("rocketPlan", activeRocketPlanId);
    window.location.href = `/checkout?${params.toString()}`;
  }

  function openRocketSelector() {
    setRocketPlanChoice(cart.includes("rocket") ? (cartPlans.rocket || DEFAULT_ROCKET_PLAN) : DEFAULT_ROCKET_PLAN);
    setRocketPickerOpen(true);
  }

  function handleCartAction(item) {
    if (item.key === "rocket") {
      if (isInCart("rocket")) {
        removeFromCart("rocket");
        setRocketPlanChoice(DEFAULT_ROCKET_PLAN);
      } else {
        openRocketSelector();
      }
      return;
    }
    if (isInCart(item.key)) {
      removeFromCart(item.key);
    } else {
      addToCart(item.key);
    }
  }

  function addRocketPlanToCart() {
    const planId = ROCKET_PLANS[rocketPlanChoice] ? rocketPlanChoice : DEFAULT_ROCKET_PLAN;
    addToCart("rocket", { plan: planId });
    setSelectedKey(null);
    setRocketPickerOpen(false);
  }

  return (
    <div className="page-shell shop-page-shell">
      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="brand-wrap" aria-label="返回首页">
            <img src="/logo.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <nav className="desktop-nav">
            <Link href="/#layout">下单流程</Link>
            <Link href="/service-center#order-query">订单查询</Link>
            <Link href="/service-center#faq">FAQ</Link>
          </nav>
        </div>
      </header>

      <main className="main-content shop-main">
        <section className="section container shop-title-section">
          <Link href="/" className="shop-back-link"><ArrowLeft size={14} />返回首页</Link>
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">服务产品</div>
              <h1 className="section-title">服务选购</h1>
              <p className="section-note">流媒体会员与节点服务，稳定交付</p>
            </div>
          </div>
        </section>

        <section className="section container shop-products-section">
          <div className="products-grid products-grid-32">
            {PRODUCTS.map((item) => {
              const promo = PRODUCT_PROMOS[item.key] || {};
              const BadgeIcon = promo.badgeIcon || Sparkles;
              const saved = Number(promo.originalPrice || 0) - Number(item.amount || 0);
              const added = isInCart(item.key);
              return (
                <article
                  key={item.key}
                  className={`glass-card product-card product-card-mini product-card-clickable${added ? " product-card-selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    if (event.target instanceof Element && event.target.closest("button, a, input, textarea")) return;
                    setSelectedKey(item.key);
                  }}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && event.currentTarget === event.target) {
                      setSelectedKey(item.key);
                    }
                  }}
                >
                  {promo.badge && (
                    <div className="product-badge">
                      <BadgeIcon size={12} /> {promo.badge}
                    </div>
                  )}
                  <div className="product-card-top">
                    <img src={item.image} alt={item.title} className="product-image" />
                    <div className="product-name-block">
                      <div className="product-name">{item.title}</div>
                      <div className="product-subtitle">{item.subtitle}</div>
                    </div>
                  </div>
                  <div className="price-box price-box-pro">
                    <div className="price-main">
                      <span className="price-now">¥{item.amount}</span>
                      <span className="price-cycle">/{item.key === "rocket" ? `${item.cycle}起` : item.cycle}</span>
                      {promo.originalPrice && <span className="price-original">¥{promo.originalPrice}</span>}
                    </div>
                    <div className="price-meta">
                      {saved > 0 && <span className="price-save">立省 ¥{saved}</span>}
                      <span className="price-usdt-hint">USDT支付 9 折</span>
                    </div>
                  </div>
                  <div className="product-social-proof">
                    <Flame size={11} /> 本月已售 {promo.soldThisMonth || 0} 份
                  </div>
                  <div
                    className="product-card-actions"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="text-btn product-detail-link"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedKey(item.key);
                      }}
                    >
                      查看详情 <ArrowRight size={12} />
                    </button>
                    <button
                      type="button"
                      className={`primary-btn product-cta${added ? " in-cart" : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleCartAction(item);
                      }}
                    >
                      {added ? <Check size={14} /> : <ShoppingCart size={14} />}
                      {added ? "已加入" : "加入购物车"}
                    </button>
                  </div>
                </article>
              );
            })}

            <article className="glass-card product-card product-card-mini product-promo-card" aria-label="咨询更多流媒体服务">
              <div className="product-badge product-badge-soon"><Headphones size={12} />人工报价</div>
              <div className="product-card-top more-service-top">
                <div className="more-service-icon" aria-hidden="true">
                  <img src="/more-service-logo.png" alt="" />
                </div>
                <div className="product-name-block">
                  <div className="product-name">更多服务咨询</div>
                  <div className="product-subtitle">YouTube / Apple TV+ / DAZN / Prime Video / ChatGPT 等</div>
                </div>
              </div>
              <div className="more-service-consult-box">
                <strong>没找到想要的平台?</strong>
                <span>联系客服说明平台、地区、时长或团队数量，客服会按需报价</span>
              </div>
              <div className="more-service-tags" aria-label="可咨询服务示例">
                {["YouTube", "Apple TV+", "DAZN", "Prime Video"].map((label) => (
                  <span key={label} className={`service-chip service-chip-${serviceIcon(label)}`}>
                    <i aria-hidden="true">{label === "YouTube" ? "▶" : label === "Apple TV+" ? "tv+" : label === "DAZN" ? "DAZN" : "prime"}</i>
                    {label}
                  </span>
                ))}
              </div>
              <div className="more-service-consult-actions">
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCopy("@MaoyangSupport", "telegram");
                  }}
                >
                  <Copy size={12} />{copiedKey === "telegram" ? "已复制" : "复制 Telegram"}
                </button>
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCopy("+1 4315093334", "whatsapp");
                  }}
                >
                  <Copy size={12} />{copiedKey === "whatsapp" ? "已复制" : "复制 WhatsApp"}
                </button>
              </div>
            </article>
          </div>
        </section>
      </main>

      {cartCount > 0 && (
        <>
          {cartExpanded && <button type="button" className="cart-backdrop" aria-label="关闭购物车" onClick={() => setCartExpanded(false)} />}
          <div className={`cart-bar${cartExpanded ? " expanded" : ""}`} role="region" aria-label="购物车">
            {cartExpanded && (
              <div className="cart-bar-panel">
                <div className="cart-bar-panel-head">
                  <strong>已选商品</strong>
                  <button type="button" className="cart-bar-panel-close" onClick={() => setCartExpanded(false)} aria-label="收起购物车">
                    <X size={15} />
                  </button>
                </div>
                <div className="cart-bar-panel-list">
                  {cartItems.map((item) => (
                    <div key={item.key} className="cart-bar-panel-item">
                      <img src={item.image} alt={item.title} />
                      <div className="cart-bar-panel-info">
                        <strong>{item.title}</strong>
                        <span>
                          ¥{productItemAmount(item, planMap[item.key])} / {item.key === "rocket" ? getRocketPlan(planMap.rocket).label : item.cycle}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="cart-bar-panel-remove"
                        onClick={() => {
                          removeFromCart(item.key);
                          if (item.key === "rocket") setRocketPlanChoice(DEFAULT_ROCKET_PLAN);
                        }}
                        aria-label={`移除 ${item.title}`}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                {savings > 0 && (
                  <div className="cart-bar-panel-discount">
                    <span>{bundleDiscountLabel(cartCount)}</span>
                    <b>已省 ¥{savings.toFixed(2)}</b>
                  </div>
                )}
              </div>
            )}
            <button type="button" className="cart-bar-info" onClick={() => setCartExpanded((value) => !value)}>
              <ShoppingCart size={22} />
              <span className="cart-bar-count">已选 {cartCount} 件商品</span>
              <span className="cart-bar-total">
                {savings > 0 && <s>¥{subtotal}</s>}
                <b>合计 ¥{finalAmount.toFixed(2)}</b>
              </span>
              {cartCount >= 2 && <span className="cart-bar-discount-tag">{bundleDiscountLabel(cartCount)}</span>}
            </button>
            <button type="button" className="cart-bar-checkout" onClick={goCheckout}>
              去结算 <ArrowRight size={16} />
            </button>
          </div>
        </>
      )}

      {selectedProduct && (
        <div className="modal-mask product-detail-mask" onClick={() => setSelectedKey(null)}>
          <div className="modal-card modal-large product-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-head-left">
                <img src={selectedProduct.image} alt={selectedProduct.title} className="modal-product-image" />
                <div>
                  <div className="section-kicker">详情介绍</div>
                  <div className="modal-title">{selectedProduct.title} 详情预览</div>
                </div>
              </div>
              <button className="close-btn" onClick={() => setSelectedKey(null)} aria-label="关闭">
                <X size={22} />
              </button>
            </div>
            <div className="modal-grid">
              <div className="modal-left-box">
                <div className="modal-price">
                  {selectedProduct.price}
                </div>
                <div className="modal-intro-box">{selectedProduct.shortIntro}</div>
                <div className="bullet-list">
                  {selectedProduct.highlights.map((bullet) => (
                    <div key={bullet} className="bullet-item">
                      <CheckCircle2 size={15} />
                      {bullet}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="detail-title">{selectedProduct.detailTitle}</div>
                <div className="detail-body">{selectedProduct.detailBody}</div>
                <div className="modal-actions">
                  <button
                    className={`primary-btn${isInCart(selectedProduct.key) ? " in-cart" : ""}`}
                    onClick={() => selectedProduct.key === "rocket"
                      ? openRocketSelector()
                      : handleCartAction(selectedProduct)}
                  >
                    {isInCart(selectedProduct.key) ? <Check size={16} /> : <ShoppingCart size={16} />}
                    {selectedProduct.key === "rocket"
                      ? (isInCart(selectedProduct.key) ? "更换套餐" : "选择套餐")
                      : (isInCart(selectedProduct.key) ? "已加入购物车" : "加入购物车")}
                  </button>
                  <Link href="/service-center#contact" className="secondary-btn">
                    <MessageCircleMore size={16} />
                    联系在线客服
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {rocketPickerOpen && (
        <div className="modal-mask product-detail-mask" onClick={() => setRocketPickerOpen(false)}>
          <div className="modal-card rocket-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-head-left">
                <img src="/products/rocket.jpg" alt="机场节点" className="modal-product-image" />
                <div>
                  <div className="section-kicker">套餐选择</div>
                  <div className="modal-title">机场节点 · 选择套餐</div>
                </div>
              </div>
              <button className="close-btn" onClick={() => setRocketPickerOpen(false)} aria-label="关闭">
                <X size={22} />
              </button>
            </div>
            <div className="shop-rocket-plan-picker compact" aria-label="选择机场节点套餐">
              {Object.values(ROCKET_PLANS).map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  className={`shop-rocket-plan-option${rocketPlanChoice === plan.id ? " selected" : ""}`}
                  onClick={() => setRocketPlanChoice(plan.id)}
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
              <button className="primary-btn" onClick={addRocketPlanToCart}>
                <ShoppingCart size={16} />
                选择套餐并加入
              </button>
              <Link href="/service-center#contact" className="secondary-btn">
                <MessageCircleMore size={16} />
                联系在线客服
              </Link>
            </div>
          </div>
        </div>
      )}

      <FloatingSupport />
      <MobileNav />
    </div>
  );
}
