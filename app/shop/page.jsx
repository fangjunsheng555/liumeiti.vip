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
  MessageCircleMore,
  ShoppingCart,
  Sparkles,
  Star,
  Tag,
  X,
} from "lucide-react";
import {
  PRODUCTS,
  PRODUCT_EN,
  DEFAULT_PRODUCT_PLANS,
  getProductPlan,
  getProductPlanOptions,
  getDefaultProductPlan,
  hasProductPlans,
  localizeProduct,
  localizePlan,
  useCart,
  cartSubtotalCny,
  cartFinalCny,
  bundleDiscountLabel,
  productItemAmount,
} from "../lib/store";
import MobileNav from "../components/MobileNav";
import FloatingSupport from "../components/FloatingSupport";
import { SERVICE_SLUG_BY_KEY } from "../services/service-data";
import { useLocale } from "../components/LocaleProvider";

const PRODUCT_PROMOS = {
  spotify: { badge: "热销 No.1", badgeIcon: Flame, originalPrice: 298, monthlyRange: [5200, 7600] },
  netflix: { badge: "影视首选", badgeIcon: Star, originalPrice: 398, monthlyRange: [4300, 6800] },
  disney: { badge: "性价比之选", badgeIcon: Gift, originalPrice: 268, monthlyRange: [3100, 5300] },
  max: { badge: "影迷经典最爱", badgeIcon: Tag, originalPrice: 348, monthlyRange: [2600, 4600] },
  rocket: { badge: "必备工具", badgeIcon: Sparkles, originalPrice: 268, monthlyRange: [6200, 9200] },
  ai: { badge: "AI 精选", badgeIcon: Sparkles, originalPrice: 398, monthlyRange: [1600, 3200] },
};

const OPERATION_SLOT_MINUTES = 10;
const OPERATION_SLOTS_PER_DAY = 24 * 60 / OPERATION_SLOT_MINUTES;
const AVERAGE_DAILY_ORDER_TARGET = 1275;

function seededUnit(seed) {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function beijingParts(date = new Date()) {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: beijing.getUTCFullYear(),
    month: beijing.getUTCMonth() + 1,
    day: beijing.getUTCDate(),
    hour: beijing.getUTCHours(),
    minute: beijing.getUTCMinutes(),
    second: beijing.getUTCSeconds(),
  };
}

function daySeed(parts) {
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function operationWeight(hour) {
  if (hour >= 0 && hour < 6) return 0.16;
  if (hour >= 6 && hour < 8) return 0.55;
  if (hour >= 8 && hour < 11) return 1.32;
  if (hour >= 11 && hour < 14) return 0.82;
  if (hour >= 14 && hour < 17) return 0.96;
  if (hour >= 17 && hour < 21) return 1.42;
  if (hour >= 21 && hour < 23) return 0.78;
  return 0.28;
}

function slotWeight(slot, seed) {
  const hour = Math.floor((slot * OPERATION_SLOT_MINUTES) / 60);
  const jitter = 0.74 + seededUnit(seed + slot * 17) * 0.52;
  return operationWeight(hour) * jitter;
}

function dailyOrderTarget(seed) {
  return Math.min(1500, Math.floor(1080 + seededUnit(seed + 91) * 390));
}

function processedOrderCount(parts) {
  const seed = daySeed(parts);
  const target = dailyOrderTarget(seed);
  const currentSlot = Math.min(OPERATION_SLOTS_PER_DAY - 1, Math.floor((parts.hour * 60 + parts.minute) / OPERATION_SLOT_MINUTES));
  const slotProgress = ((parts.minute % OPERATION_SLOT_MINUTES) * 60 + parts.second) / (OPERATION_SLOT_MINUTES * 60);
  let fullDayWeight = 0;
  let elapsedWeight = 0;
  for (let slot = 0; slot < OPERATION_SLOTS_PER_DAY; slot += 1) {
    const weight = slotWeight(slot, seed);
    fullDayWeight += weight;
    if (slot < currentSlot) elapsedWeight += weight;
    if (slot === currentSlot) elapsedWeight += weight * slotProgress;
  }
  return Math.min(1500, Math.floor(target * (elapsedWeight / fullDayWeight)));
}

function daysInBeijingMonth(parts) {
  return new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
}

function productMonthlySold(productKey, range = [3000, 5000], date = new Date()) {
  const parts = beijingParts(date);
  const daysInMonth = daysInBeijingMonth(parts);
  const keySeed = productKey.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const monthSeed = parts.year * 100 + parts.month + keySeed * 13;
  const target = Math.floor(range[0] + seededUnit(monthSeed) * (range[1] - range[0]));
  const completedDays = Math.max(0, parts.day - 1);
  const previousDaysRatio = completedDays / Math.max(1, daysInMonth);
  const previousDaysWave = 0.985 + seededUnit(monthSeed + completedDays * 37) * 0.03;
  const previousSold = target * previousDaysRatio * previousDaysWave;
  const todaySeed = daySeed(parts);
  const todayTarget = dailyOrderTarget(todaySeed);
  const todayDone = processedOrderCount(parts);
  const todayRatio = Math.max(0, Math.min(1, todayDone / Math.max(1, todayTarget)));
  const dailyDemand = Math.max(0.82, Math.min(1.22, todayTarget / AVERAGE_DAILY_ORDER_TARGET));
  const productWave = 0.92 + seededUnit(todaySeed + keySeed * 19) * 0.16;
  const expectedToday = (target / Math.max(1, daysInMonth)) * dailyDemand * productWave;
  return Math.max(18, Math.min(target, Math.floor(previousSold + expectedToday * todayRatio)));
}

const BADGE_EN = {
  "热销 No.1": "Best seller",
  "影视首选": "Top pick",
  "性价比之选": "Best value",
  "影迷经典最爱": "Fan favorite",
  "必备工具": "Essential",
  "AI 精选": "AI pick",
  "人工报价": "Custom quote",
};

export default function ShopPage() {
  const { locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const [selectedKey, setSelectedKey] = useState(null);
  const [planPickerKey, setPlanPickerKey] = useState(null);
  const [planChoices, setPlanChoices] = useState(DEFAULT_PRODUCT_PLANS);
  const [cartExpanded, setCartExpanded] = useState(false);
  const [soldTick, setSoldTick] = useState(() => Date.now());
  const [aiSoldOut, setAiSoldOut] = useState({});
  const { cart, cartPlans, addToCart, removeFromCart } = useCart();

  const selectedProductRaw = useMemo(() => PRODUCTS.find((item) => item.key === selectedKey) || null, [selectedKey]);
  const planPickerProduct = useMemo(() => PRODUCTS.find((item) => item.key === planPickerKey) || null, [planPickerKey]);
  const selectedProduct = useMemo(() => localizeProduct(selectedProductRaw, locale), [selectedProductRaw, locale]);
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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ai-stock", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.ok) setAiSoldOut(d.soldOut || {}); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function isInCart(key) {
    return cart.includes(key);
  }

  function isPlanSoldOut(key, planId) {
    return key === "ai" && Boolean(aiSoldOut[planId]);
  }

  function allPlansSoldOut(key) {
    if (key !== "ai") return false;
    const opts = getProductPlanOptions(key);
    return opts.length > 0 && opts.every((p) => aiSoldOut[p.id]);
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
    let plan = getProductPlan(
      item.key,
      cart.includes(item.key) ? (cartPlans[item.key] || planChoices[item.key]) : (planChoices[item.key] || getDefaultProductPlan(item.key)),
    );
    if (plan && isPlanSoldOut(item.key, plan.id)) {
      const firstAvailable = getProductPlanOptions(item.key).find((p) => !isPlanSoldOut(item.key, p.id));
      if (firstAvailable) plan = firstAvailable;
    }
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
    const planId = planChoices[item.key] || getDefaultProductPlan(item.key);
    if (isPlanSoldOut(item.key, planId)) return;
    const plan = getProductPlan(item.key, planId);
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
            <Link href="/#layout">{L("下单流程", "How it works")}</Link>
            <Link href="/service-center#order-query">{L("订单查询", "Track order")}</Link>
            <Link href="/legal">{L("企业保障", "Guarantees")}</Link>
            <Link href="/service-center#faq">FAQ</Link>
          </nav>
        </div>
      </header>

      <main className="main-content shop-main">
        <section className="section container shop-title-section">
          <Link href="/" className="shop-back-link"><ArrowLeft size={14} />{L("返回首页", "Home")}</Link>
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">{L("服务产品", "Services")}</div>
              <h1 className="section-title">{L("服务选购", "Shop services")}</h1>
              <p className="section-note">{L("流媒体会员与节点服务，稳定交付", "Reliable memberships & VPN")}</p>
            </div>
          </div>
        </section>

        <section className="section container shop-products-section">
          <div className="products-grid products-grid-32">
            {PRODUCTS.map((item) => {
              const promo = PRODUCT_PROMOS[item.key] || {};
              const BadgeIcon = promo.badgeIcon || Sparkles;
              const defaultPlan = hasProductPlans(item.key) ? localizePlan(item.key, getProductPlan(item.key, getDefaultProductPlan(item.key)), locale) : null;
              const displayAmount = defaultPlan?.amount || item.amount;
              const displayCycle = defaultPlan?.unit || defaultPlan?.cycle || (hasProductPlans(item.key) ? L("年起", "yr") : (locale === "en" ? (PRODUCT_EN[item.key]?.cycle || item.cycle) : item.cycle));
              const saved = Number(promo.originalPrice || 0) - Number(displayAmount || 0);
              const soldThisMonth = productMonthlySold(item.key, promo.monthlyRange, new Date(soldTick));
              const added = isInCart(item.key);
              const soldOut = allPlansSoldOut(item.key);
              return (
                <article
                  key={item.key}
                  className={`glass-card product-card product-card-mini product-card-clickable svc-${item.key}${added ? " product-card-selected" : ""}`}
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
                      <BadgeIcon size={12} /> {locale === "en" ? (BADGE_EN[promo.badge] || promo.badge) : promo.badge}
                    </div>
                  )}
                  <div className="product-card-top">
                    <img src={item.image} alt={item.title} className="product-image" loading="lazy" decoding="async" width="56" height="56" />
                    <div className="product-name-block">
                      <div className="product-name">{locale === "en" ? (PRODUCT_EN[item.key]?.title || item.title) : item.title}</div>
                      <div className="product-subtitle">{locale === "en" ? (PRODUCT_EN[item.key]?.subtitle || item.subtitle) : item.subtitle}</div>
                    </div>
                  </div>
                  <div className="price-box price-box-pro">
                    <div className="price-main">
                      <span className="price-now">¥{displayAmount}</span>
                      <span className="price-cycle">/{displayCycle}</span>
                      {promo.originalPrice && <span className="price-original">¥{promo.originalPrice}</span>}
                    </div>
                    <div className="price-meta">
                      {saved > 0 && <span className="price-save">{L("立省", "Save")} ¥{saved}</span>}
                      <span className="price-usdt-hint">{L("USDT支付 9 折", "10% off with USDT")}</span>
                    </div>
                  </div>
                  <div className="product-social-proof">
                    <Flame size={11} /> {L("本月已售", "Sold this month:")} {soldThisMonth.toLocaleString(locale === "en" ? "en-US" : "zh-CN")} {L("份", "")}
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
                      {L("查看详情", "View details")} <ArrowRight size={12} />
                    </button>
                    <button
                      type="button"
                      className={`primary-btn product-cta${added ? " in-cart" : ""}${soldOut ? " sold-out" : ""}`}
                      disabled={soldOut}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleCartAction(item);
                      }}
                    >
                      {soldOut ? null : added ? <Check size={14} /> : <ShoppingCart size={14} />}
                      {soldOut ? L("已售罄", "Sold out") : added ? L("已加入", "Added") : L("加入购物车", "Add to cart")}
                    </button>
                  </div>
                </article>
              );
            })}
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
                  <strong>{L("已选商品", "Selected items")}</strong>
                  <button type="button" className="cart-bar-panel-close" onClick={() => setCartExpanded(false)} aria-label={L("收起购物车", "Collapse cart")}>
                    <X size={15} />
                  </button>
                </div>
                <div className="cart-bar-panel-list">
                  {cartItems.map((item) => {
                    const itemL = localizeProduct(item, locale);
                    return (
                    <div key={item.key} className="cart-bar-panel-item">
                      <img src={item.image} alt={itemL.title} />
                      <div className="cart-bar-panel-info">
                        <strong>{itemL.title}</strong>
                        <span>
                          ¥{productItemAmount(item, planMap[item.key])} / {hasProductPlans(item.key) ? localizePlan(item.key, getProductPlan(item.key, planMap[item.key]), locale)?.label : itemL.cycle}
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
                        aria-label={L(`移除 ${item.title}`, `Remove ${itemL.title}`)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    );
                  })}
                </div>
                {savings > 0 && (
                  <div className="cart-bar-panel-discount">
                    <span>{bundleDiscountLabel(cartCount, locale)}</span>
                    <b>{L("已省", "Saved")} ¥{savings.toFixed(2)}</b>
                  </div>
                )}
              </div>
            )}
            <button type="button" className="cart-bar-info" onClick={() => setCartExpanded((value) => !value)}>
              <ShoppingCart size={22} />
              <span className="cart-bar-count">{L("已选", "")} {cartCount} {L("件商品", "item(s)")}</span>
              <span className="cart-bar-total">
                {savings > 0 && <s>¥{subtotal}</s>}
                <b>{L("合计", "Total")} ¥{finalAmount.toFixed(2)}</b>
              </span>
              {cartCount >= 2 && <span className="cart-bar-discount-tag">{bundleDiscountLabel(cartCount, locale)}</span>}
            </button>
            <button type="button" className="cart-bar-checkout" onClick={goCheckout}>
              {L("去结算", "Checkout")} <ArrowRight size={16} />
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
                  <div className="section-kicker">{L("详情介绍", "Details")}</div>
                  <div className="modal-title">{(locale === "en" ? (PRODUCT_EN[selectedProduct.key]?.title || selectedProduct.title) : selectedProduct.title)} {L("详情预览", "preview")}</div>
                </div>
              </div>
              <button className="close-btn" onClick={() => setSelectedKey(null)} aria-label={L("关闭", "Close")}>
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
                    className={`primary-btn${isInCart(selectedProduct.key) ? " in-cart" : ""}${allPlansSoldOut(selectedProduct.key) ? " sold-out" : ""}`}
                    disabled={allPlansSoldOut(selectedProduct.key)}
                    onClick={() => hasProductPlans(selectedProduct.key)
                      ? openPlanSelector(selectedProduct)
                      : handleCartAction(selectedProduct)}
                  >
                    {allPlansSoldOut(selectedProduct.key) ? null : isInCart(selectedProduct.key) ? <Check size={16} /> : <ShoppingCart size={16} />}
                    {allPlansSoldOut(selectedProduct.key)
                      ? L("已售罄", "Sold out")
                      : hasProductPlans(selectedProduct.key)
                      ? (isInCart(selectedProduct.key) ? L("更换规格", "Change plan") : L("选择规格", "Select plan"))
                      : (isInCart(selectedProduct.key) ? L("已加入购物车", "In cart") : L("加入购物车", "Add to cart"))}
                  </button>
                  <Link href="/service-center#contact" className="secondary-btn">
                    <MessageCircleMore size={16} />
                    {L("联系客服", "Support")}
                  </Link>
                  {SERVICE_SLUG_BY_KEY[selectedProduct.key] && (
                    <Link href={`/services/${SERVICE_SLUG_BY_KEY[selectedProduct.key]}`} className="secondary-btn">
                      <ArrowRight size={16} />
                      {L("服务指南", "Guide")}
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
                  <div className="section-kicker">{L("规格选择", "Select plan")}</div>
                  <div className="modal-title">{(locale === "en" ? (PRODUCT_EN[planPickerProduct.key]?.title || planPickerProduct.title) : planPickerProduct.title)} · {L("选择规格", "Select plan")}</div>
                </div>
              </div>
              <button className="close-btn" onClick={() => setPlanPickerKey(null)} aria-label={L("关闭", "Close")}>
                <X size={22} />
              </button>
            </div>
            <div className="shop-rocket-plan-picker compact" aria-label={locale === "en" ? `Select ${localizeProduct(planPickerProduct, locale).title} plan` : `选择${planPickerProduct.title}规格`}>
              {getProductPlanOptions(planPickerProduct.key).map((rawPlan) => {
                const plan = localizePlan(planPickerProduct.key, rawPlan, locale);
                const optSoldOut = isPlanSoldOut(planPickerProduct.key, plan.id);
                return (
                <button
                  key={plan.id}
                  type="button"
                  disabled={optSoldOut}
                  className={`shop-rocket-plan-option${planChoices[planPickerProduct.key] === plan.id ? " selected" : ""}${optSoldOut ? " sold-out" : ""}`}
                  onClick={() => { if (!optSoldOut) setPlanChoices((current) => ({ ...current, [planPickerProduct.key]: plan.id })); }}
                >
                  <span>
                    <strong>{plan.label}{optSoldOut ? ` · ${L("已售罄", "Sold out")}` : ""}</strong>
                    <small>{plan.desc}</small>
                  </span>
                  <b>¥{plan.amount}<em>/{plan.unit || (locale === "en" ? "yr" : "年")}</em></b>
                </button>
                );
              })}
            </div>
            <div className="modal-actions rocket-picker-actions">
              <button
                className="primary-btn"
                onClick={addSelectedPlanToCart}
                disabled={isPlanSoldOut(planPickerProduct.key, planChoices[planPickerProduct.key] || getDefaultProductPlan(planPickerProduct.key))}
              >
                <ShoppingCart size={16} />
                {isPlanSoldOut(planPickerProduct.key, planChoices[planPickerProduct.key] || getDefaultProductPlan(planPickerProduct.key)) ? L("已售罄", "Sold out") : L("选择规格并加入", "Add to cart")}
              </button>
              <Link href="/service-center#contact" className="secondary-btn">
                <MessageCircleMore size={16} />
                {L("联系客服", "Support")}
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
