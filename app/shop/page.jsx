"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
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
  DEFAULT_PRODUCT_PLANS,
  getProductPlan,
  getProductPlanOptions,
  getDefaultProductPlan,
  hasProductPlans,
  useCart,
  cartSubtotalCny,
  cartFinalCny,
  bundleDiscountLabel,
  productItemAmount,
} from "../lib/store";
import MobileNav from "../components/MobileNav";
import FloatingSupport from "../components/FloatingSupport";
import { SERVICE_SLUG_BY_KEY } from "../services/service-data";

const PRODUCT_PROMOS = {
  spotify: { badge: "热销 No.1", badgeIcon: Flame, originalPrice: 298, monthlyRange: [5200, 7600] },
  netflix: { badge: "影视首选", badgeIcon: Star, originalPrice: 398, monthlyRange: [4300, 6800] },
  disney: { badge: "性价比之选", badgeIcon: Gift, originalPrice: 268, monthlyRange: [3100, 5300] },
  max: { badge: "影迷经典最爱", badgeIcon: Tag, originalPrice: 348, monthlyRange: [2600, 4600] },
  rocket: { badge: "必备工具", badgeIcon: Sparkles, originalPrice: 268, monthlyRange: [6200, 9200] },
};

function serviceIcon(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function seededUnit(seed) {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function productMonthlySold(productKey, range = [3000, 5000], date = new Date()) {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = beijing.getUTCFullYear();
  const month = beijing.getUTCMonth();
  const start = Date.UTC(year, month, 1);
  const end = Date.UTC(year, month + 1, 1);
  const now = Date.UTC(year, month, beijing.getUTCDate(), beijing.getUTCHours(), beijing.getUTCMinutes(), beijing.getUTCSeconds());
  const progress = Math.max(0.01, Math.min(0.995, (now - start) / Math.max(1, end - start)));
  const keySeed = productKey.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const monthSeed = year * 100 + month + 1 + keySeed * 13;
  const target = Math.floor(range[0] + seededUnit(monthSeed) * (range[1] - range[0]));
  const dayWave = 0.96 + seededUnit(monthSeed + beijing.getUTCDate() * 97 + beijing.getUTCHours()) * 0.08;
  return Math.max(18, Math.min(target, Math.floor(target * Math.pow(progress, 0.98) * dayWave)));
}

export default function ShopPage() {
  const [selectedKey, setSelectedKey] = useState(null);
  const [planPickerKey, setPlanPickerKey] = useState(null);
  const [planChoices, setPlanChoices] = useState(DEFAULT_PRODUCT_PLANS);
  const [cartExpanded, setCartExpanded] = useState(false);
  const [soldTick, setSoldTick] = useState(0);
  const { cart, cartPlans, addToCart, removeFromCart } = useCart();

  const selectedProduct = useMemo(() => PRODUCTS.find((item) => item.key === selectedKey) || null, [selectedKey]);
  const planPickerProduct = useMemo(() => PRODUCTS.find((item) => item.key === planPickerKey) || null, [planPickerKey]);
  const cartItems = useMemo(() => cart.map((key) => PRODUCTS.find((p) => p.key === key)).filter(Boolean), [cart]);
  const cartCount = cartItems.length;
  const planMap = Object.fromEntries(
    cartItems
      .filter((item) => hasProductPlans(item.key))
      .map((item) => {
        const plan = getProductPlan(
          item.key,
          cartPlans[item.key] || planChoices[item.key] || getDefaultProductPlan(item.key),
        );
        return [item.key, plan?.id || getDefaultProductPlan(item.key)];
      }),
  );
  const subtotal = cartSubtotalCny(cartItems, planMap);
  const finalAmount = cartFinalCny(cartItems, planMap);
  const savings = subtotal - finalAmount;

  useEffect(() => {
    setPlanChoices((current) => {
      const next = { ...current };
      Object.keys(cartPlans || {}).forEach((key) => {
        const plan = getProductPlan(key, cartPlans[key]);
        if (plan) next[key] = plan.id;
      });
      return next;
    });
  }, [cartPlans]);

  useEffect(() => {
    const timer = setInterval(() => setSoldTick(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  function isInCart(key) {
    return cart.includes(key);
  }

  function goCheckout() {
    if (cartCount === 0) return;
    const params = new URLSearchParams();
    params.set("items", cartItems.map((item) => item.key).join(","));
    cartItems.forEach((item) => {
      if (!hasProductPlans(item.key)) return;
      const plan = getProductPlan(item.key, planMap[item.key]);
      if (!plan) return;
      params.set(`${item.key}Plan`, plan.id);
      if (item.key === "rocket") params.set("rocketPlan", plan.id);
    });
    window.location.href = `/checkout?${params.toString()}`;
  }

  function openPlanSelector(item) {
    if (!item || !hasProductPlans(item.key)) return;
    const plan = getProductPlan(
      item.key,
      cart.includes(item.key) ? (cartPlans[item.key] || planChoices[item.key]) : (planChoices[item.key] || getDefaultProductPlan(item.key)),
    );
    setPlanChoices((current) => ({ ...current, [item.key]: plan?.id || getDefaultProductPlan(item.key) }));
    setPlanPickerKey(item.key);
  }

  function handleCartAction(item) {
    if (hasProductPlans(item.key)) {
      if (isInCart(item.key)) {
        removeFromCart(item.key);
        setPlanChoices((current) => ({ ...current, [item.key]: getDefaultProductPlan(item.key) }));
      } else {
        openPlanSelector(item);
      }
      return;
    }
    if (isInCart(item.key)) {
      removeFromCart(item.key);
    } else {
      addToCart(item.key);
    }
  }

  function addSelectedPlanToCart() {
    const item = planPickerProduct;
    if (!item) return;
    const plan = getProductPlan(item.key, planChoices[item.key] || getDefaultProductPlan(item.key));
    addToCart(item.key, { plan: plan?.id || getDefaultProductPlan(item.key) });
    setSelectedKey(null);
    setPlanPickerKey(null);
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
            <Link href="/legal">企业保障</Link>
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
              const defaultPlan = hasProductPlans(item.key) ? getProductPlan(item.key, getDefaultProductPlan(item.key)) : null;
              const displayAmount = defaultPlan?.amount || item.amount;
              const displayCycle = defaultPlan?.unit || defaultPlan?.cycle || (hasProductPlans(item.key) ? "年起" : item.cycle);
              const saved = Number(promo.originalPrice || 0) - Number(displayAmount || 0);
              const soldThisMonth = soldTick
                ? productMonthlySold(item.key, promo.monthlyRange, new Date(soldTick))
                : Math.max(18, Math.floor(((promo.monthlyRange?.[0] || 3000) + (promo.monthlyRange?.[1] || 5000)) / 45));
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
                      <span className="price-now">¥{displayAmount}</span>
                      <span className="price-cycle">/{displayCycle}</span>
                      {promo.originalPrice && <span className="price-original">¥{promo.originalPrice}</span>}
                    </div>
                    <div className="price-meta">
                      {saved > 0 && <span className="price-save">立省 ¥{saved}</span>}
                      <span className="price-usdt-hint">USDT支付 9 折</span>
                    </div>
                  </div>
                  <div className="product-social-proof">
                    <Flame size={11} /> 本月已售 {soldThisMonth.toLocaleString("zh-CN")} 份
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
                <Link
                  href="/service-center#contact"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <MessageCircleMore size={12} /> 在线咨询
                </Link>
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
                          ¥{productItemAmount(item, planMap[item.key])} / {hasProductPlans(item.key) ? getProductPlan(item.key, planMap[item.key])?.label : item.cycle}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="cart-bar-panel-remove"
                        onClick={() => {
                          removeFromCart(item.key);
                          if (hasProductPlans(item.key)) {
                            setPlanChoices((current) => ({ ...current, [item.key]: getDefaultProductPlan(item.key) }));
                          }
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
                <div className="modal-actions product-detail-actions">
                  <button
                    className={`primary-btn${isInCart(selectedProduct.key) ? " in-cart" : ""}`}
                    onClick={() => hasProductPlans(selectedProduct.key)
                      ? openPlanSelector(selectedProduct)
                      : handleCartAction(selectedProduct)}
                  >
                    {isInCart(selectedProduct.key) ? <Check size={16} /> : <ShoppingCart size={16} />}
                    {hasProductPlans(selectedProduct.key)
                      ? (isInCart(selectedProduct.key) ? "更换规格" : "选择规格")
                      : (isInCart(selectedProduct.key) ? "已加入购物车" : "加入购物车")}
                  </button>
                  <Link href="/service-center#contact" className="secondary-btn">
                    <MessageCircleMore size={16} />
                    联系在线客服
                  </Link>
                  {SERVICE_SLUG_BY_KEY[selectedProduct.key] && (
                    <Link href={`/services/${SERVICE_SLUG_BY_KEY[selectedProduct.key]}`} className="secondary-btn">
                      <ArrowRight size={16} />
                      服务指南
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {planPickerProduct && (
        <div className="modal-mask product-detail-mask" onClick={() => setPlanPickerKey(null)}>
          <div className="modal-card rocket-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-head-left">
                <img src={planPickerProduct.image} alt={planPickerProduct.title} className="modal-product-image" />
                <div>
                  <div className="section-kicker">规格选择</div>
                  <div className="modal-title">{planPickerProduct.title} · 选择规格</div>
                </div>
              </div>
              <button className="close-btn" onClick={() => setPlanPickerKey(null)} aria-label="关闭">
                <X size={22} />
              </button>
            </div>
            <div className="shop-rocket-plan-picker compact" aria-label={`选择${planPickerProduct.title}规格`}>
              {getProductPlanOptions(planPickerProduct.key).map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  className={`shop-rocket-plan-option${planChoices[planPickerProduct.key] === plan.id ? " selected" : ""}`}
                  onClick={() => setPlanChoices((current) => ({ ...current, [planPickerProduct.key]: plan.id }))}
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
              <button className="primary-btn" onClick={addSelectedPlanToCart}>
                <ShoppingCart size={16} />
                选择规格并加入
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
