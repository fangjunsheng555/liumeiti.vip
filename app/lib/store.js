"use client";

import { useEffect, useState } from "react";

export const USDT_ADDRESS = "TDoUMF4nF244o5GZvBBwX5t9axvnSoP1Cm";
export const USDT_DISCOUNT = 0.9;
export const USDT_RATE = 6.85;

export const PRODUCTS = [
  {
    key: "spotify",
    image: "/products/spotify.jpg",
    title: "Spotify",
    subtitle: "欧美日高价区多规格订阅",
    amount: 128,
    cycle: "1年",
    hasPlan: true,
    price: "¥128/年起",
    shortIntro: "欧美日高价区订阅，家庭成员、个人、双人与家庭套餐可选",
    highlights: ["高价区订阅", "多规格可选", "售后保障"],
    detailTitle: "欧美日高价区 Spotify 订阅，按需选择成员或套餐",
    detailBody:
      "支持无损音质、播客、AIDJ、离线下载、合辑歌单与完整曲库。可选家庭成员席位 ¥128/年、个人订阅 ¥388/年、双人订阅 ¥488/年（可邀请 1 个账号免费享用订阅）、家庭套餐 ¥588/年（可邀请 5 个账号免费享用订阅），均为欧美日高价区订阅并包含售后协助",
    orderTitle: "Spotify · 多规格年付订阅",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "netflix",
    image: "/products/netflix.jpg",
    title: "Netflix",
    subtitle: "全球可用4K杜比车位/整号",
    amount: 168,
    cycle: "1年",
    hasPlan: true,
    price: "¥168/年起",
    shortIntro: "最高级别4K杜比套餐，单独车位或整号购买可选",
    highlights: ["4K杜比", "车位可锁", "整号可选"],
    detailTitle: "Netflix 最高级别 4K 杜比套餐，车位与整号均可选",
    detailBody:
      "提供全球可用最高级别 4K 杜比套餐。单独车位 ¥168/年，一人独享一个用户档案，可设置 PIN 锁，高峰不排队不被挤；整号购买 ¥588/年，最多支持 5 个用户档案/车位，适合家庭或多人长期稳定使用",
    orderTitle: "Netflix · 4K杜比规格选择",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "disney",
    image: "/products/disney.jpg",
    title: "Disney+",
    subtitle: "全球可用4K杜比车位/整号",
    amount: 108,
    cycle: "1年",
    hasPlan: true,
    price: "¥108/年起",
    shortIntro: "最高级别4K杜比套餐，独立车位与整号可选",
    highlights: ["4K杜比", "全球可用", "整号可选"],
    detailTitle: "Disney+ 顶级 4K 杜比套餐，单独车位与整号可选",
    detailBody:
      "提供全球可用最高级别 4K 杜比套餐。单独车位 ¥108/年，一人一位置互不干扰；整号购买 ¥588/年，最多支持 7 个用户档案/车位，适合家庭共享与长期使用，订单均包含售后保障",
    orderTitle: "Disney+ · 4K杜比规格选择",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "max",
    image: "/products/hbomax.jpg",
    title: "HBO Max",
    subtitle: "全球可用4K杜比车位/整号",
    amount: 148,
    cycle: "1年",
    hasPlan: true,
    price: "¥148/年起",
    shortIntro: "最高级别4K杜比套餐，独立车位或整号购买可选",
    highlights: ["4K杜比", "全球可用", "整号可选"],
    detailTitle: "HBO Max 最高级别 4K 杜比套餐，车位与整号均可选",
    detailBody:
      "提供全球可用最高级别 4K 杜比套餐。单独车位 ¥148/年，一人独享一个位置，互不干扰；整号购买 ¥588/年，最多支持 5 个用户档案/车位，适合影迷家庭与多人稳定使用",
    orderTitle: "HBO Max · 4K杜比规格选择",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "rocket",
    image: "/products/rocket.jpg",
    title: "机场节点",
    subtitle: "多档真实流量套餐·最高速率5Gbps·解锁全球平台",
    amount: 128,
    cycle: "1年",
    needsUsername: true,
    hasPlan: true,
    price: "¥128/年起",
    shortIntro: "大厂机房多线路，最高5Gbps带宽，按月提供真实流量，解锁流媒体/AI/社交软件",
    highlights: ["真实流量套餐", "高速稳定多节点", "全加密无日志"],
    detailTitle: "大厂机房多线路，真实流量套餐可选，年仅 ¥128 起",
    detailBody:
      "优选大厂VPS，多线路港日台韩新美英德法等，最高速率可达5Gbps，高峰不拥堵不卡顿，解锁所有主流流媒体/AI软件/社交软件，全加密协议无日志隐私保障，实时维护24×7线路不中断。可选 普通套餐 ¥128/年（50GB/月真实流量）、高级套餐 ¥198/年（100GB/月真实流量）、豪华套餐 ¥398/年（200GB/月真实流量）、无限套餐 ¥698/年（无限流量）。另有 ¥5/次 10GB 测试套餐",
    orderTitle: "机场节点 · 支付宝扫码支付",
    orderBody:
      "请在支付完成后点击付款完成提交订单，提交后会生成订阅链接",
    qrImage: "/payment/alipay.jpg",
  },
];

export const ROCKET_PLANS = {
  basic: { id: "basic", label: "普通套餐", amount: 128, desc: "50 GB/月真实流量" },
  pro: { id: "pro", label: "高级套餐", amount: 198, desc: "100 GB/月真实流量" },
  luxury: { id: "luxury", label: "豪华套餐", amount: 398, desc: "200 GB/月真实流量" },
  unlimited: { id: "unlimited", label: "无限套餐", amount: 698, desc: "无限流量" },
  trial: { id: "trial", label: "5元10GB测试", amount: 5, desc: "10 GB测试流量", unit: "次", cycle: "次", requiresLogin: false, onePerUser: false },
};
export const PRODUCT_PLANS = {
  spotify: {
    member: { id: "member", label: "家庭成员", amount: 128, desc: "加入欧美日高价区家庭计划，成员席位" },
    individual: { id: "individual", label: "个人订阅", amount: 388, desc: "欧美日高价区个人订阅，独立使用" },
    duo: { id: "duo", label: "双人订阅", amount: 488, desc: "可邀请 1 个账号免费享用订阅" },
    family: { id: "family", label: "家庭套餐", amount: 588, desc: "可邀请 5 个账号免费享用订阅" },
  },
  netflix: {
    seat: { id: "seat", label: "单独车位", amount: 168, desc: "4K 杜比独立用户档案，可上锁" },
    full: { id: "full", label: "整号购买", amount: 588, desc: "最多支持 5 个用户档案/车位" },
  },
  disney: {
    seat: { id: "seat", label: "单独车位", amount: 108, desc: "4K 杜比独立用户档案，互不干扰" },
    full: { id: "full", label: "整号购买", amount: 588, desc: "最多支持 7 个用户档案/车位" },
  },
  max: {
    seat: { id: "seat", label: "单独车位", amount: 148, desc: "4K 杜比独立用户档案，稳定售后" },
    full: { id: "full", label: "整号购买", amount: 588, desc: "最多支持 5 个用户档案/车位" },
  },
  rocket: ROCKET_PLANS,
};
export const DEFAULT_PRODUCT_PLANS = {
  spotify: "member",
  netflix: "seat",
  disney: "seat",
  max: "seat",
  rocket: "basic",
};
export const DEFAULT_ROCKET_PLAN = DEFAULT_PRODUCT_PLANS.rocket;

export function getRocketPlan(planId) {
  return getProductPlan("rocket", planId);
}

export function rocketPlanLabel(planId) {
  return getRocketPlan(planId).label;
}

export function hasProductPlans(productKey) {
  return Boolean(PRODUCT_PLANS[productKey]);
}

export function getDefaultProductPlan(productKey) {
  return DEFAULT_PRODUCT_PLANS[productKey] || "";
}

export function isProductPlan(productKey, planId) {
  const plans = PRODUCT_PLANS[productKey];
  if (!plans || !planId) return false;
  const aliases = productKey === "rocket" ? { single: "basic" } : {};
  const id = aliases[planId] || planId;
  return Boolean(plans[id]);
}

export function getProductPlan(productKey, planId) {
  const plans = PRODUCT_PLANS[productKey];
  if (!plans) return null;
  const aliases = productKey === "rocket" ? { single: "basic" } : {};
  const id = aliases[planId] || planId || getDefaultProductPlan(productKey);
  return plans[id] || plans[getDefaultProductPlan(productKey)] || Object.values(plans)[0] || null;
}

export function getProductPlanOptions(productKey) {
  return Object.values(PRODUCT_PLANS[productKey] || {});
}

export function productItemAmount(product, plan) {
  if (!product) return 0;
  if (hasProductPlans(product.key)) return getProductPlan(product.key, plan)?.amount || product.amount;
  return product.amount;
}

export function copyText(text) {
  if (typeof window === "undefined") return;
  const fallbackCopy = () => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

export function money(amount) {
  return "¥" + Number(amount || 0).toFixed(0);
}

export function blankCheckoutForm() {
  return { email: "", contact: "", remark: "", fields: {} };
}

export function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

export function validUsername(value) {
  return /^[A-Za-z0-9]{4,10}$/.test(String(value || "").trim());
}

export function productNeedsAccountPassword(product) {
  return product?.key === "spotify";
}

export function bundleDiscountRate(itemCount) {
  if (itemCount >= 3) return 0.10;
  if (itemCount >= 2) return 0.05;
  return 0;
}

export function bundleDiscountLabel(itemCount) {
  if (itemCount >= 3) return "3 件起 9 折";
  if (itemCount === 2) return "2 件 9.5 折";
  return "";
}

export function cartSubtotalCny(items, planMap = {}) {
  return items.reduce((sum, p) => sum + productItemAmount(p, planMap?.[p?.key]), 0);
}

export function cartFinalCny(items, planMap = {}) {
  const subtotal = cartSubtotalCny(items, planMap);
  const rate = bundleDiscountRate(items.length);
  return Math.round(subtotal * (1 - rate));
}

export function cartFinalUsdt(items, planMap = {}) {
  const cny = cartFinalCny(items, planMap);
  return Math.round((cny * USDT_DISCOUNT / USDT_RATE) * 100) / 100;
}

export function usdtAmount(rmb) {
  return Math.round((Number(rmb || 0) * USDT_DISCOUNT / USDT_RATE) * 100) / 100;
}

export function subscriptionLinks(username) {
  const encoded = encodeURIComponent(String(username || "").trim());
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

const CART_STORAGE_KEY = "liumeiti:cart:v1";
const CART_PLAN_STORAGE_KEY = "liumeiti:cart-plans:v1";
const CART_EVENT = "liumeiti:cart-update";

function loadCart() {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(CART_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    const valid = new Set(PRODUCTS.map((p) => p.key));
    return parsed.filter((k) => typeof k === "string" && valid.has(k));
  } catch {
    return [];
  }
}

function emitCartUpdate() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CART_EVENT));
}

function saveCart(cart, emit = true) {
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    if (emit) emitCartUpdate();
  } catch {}
}

function loadCartPlans() {
  if (typeof window === "undefined") return {};
  try {
    const stored = localStorage.getItem(CART_PLAN_STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return {};
    const next = {};
    Object.keys(PRODUCT_PLANS).forEach((key) => {
      const value = parsed[key];
      if (!value) return;
      const plan = getProductPlan(key, value);
      if (plan && isProductPlan(key, plan.id)) next[key] = plan.id;
    });
    return next;
  } catch {
    return {};
  }
}

function saveCartPlans(plans, emit = true) {
  try {
    localStorage.setItem(CART_PLAN_STORAGE_KEY, JSON.stringify(plans || {}));
    if (emit) emitCartUpdate();
  } catch {}
}

function saveCartBundle(cart, plans) {
  saveCart(cart, false);
  saveCartPlans(plans, false);
  emitCartUpdate();
}

export function useCart() {
  const [cart, setCartState] = useState([]);
  const [cartPlans, setCartPlansState] = useState({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setCartState(loadCart());
    setCartPlansState(loadCartPlans());
    setHydrated(true);
    const sync = () => {
      setCartState(loadCart());
      setCartPlansState(loadCartPlans());
    };
    window.addEventListener(CART_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CART_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  function setCartPlan(key, planId) {
    if (!hasProductPlans(key)) return;
    const plan = getProductPlan(key, planId);
    if (!plan) return;
    const next = { ...loadCartPlans(), [key]: plan.id };
    setCartPlansState(next);
    saveCartPlans(next);
  }

  function addToCart(key, options = {}) {
    setCartState((current) => {
      const next = current.includes(key) ? current : [...current, key];
      const nextPlans = { ...loadCartPlans() };
      if (hasProductPlans(key)) {
        const plan = getProductPlan(key, options.plan || nextPlans[key] || getDefaultProductPlan(key));
        if (plan) nextPlans[key] = plan.id;
      }
      setCartPlansState(nextPlans);
      saveCartBundle(next, nextPlans);
      return next;
    });
  }

  function removeFromCart(key) {
    setCartState((current) => {
      const next = current.filter((k) => k !== key);
      const nextPlans = { ...loadCartPlans() };
      if (hasProductPlans(key)) delete nextPlans[key];
      setCartPlansState(nextPlans);
      saveCartBundle(next, nextPlans);
      return next;
    });
  }

  function toggleCart(key, options = {}) {
    setCartState((current) => {
      const removing = current.includes(key);
      const next = removing ? current.filter((k) => k !== key) : [...current, key];
      const nextPlans = { ...loadCartPlans() };
      if (hasProductPlans(key)) {
        if (removing) {
          delete nextPlans[key];
        } else {
          const plan = getProductPlan(key, options.plan || getDefaultProductPlan(key));
          if (plan) nextPlans[key] = plan.id;
        }
      }
      setCartPlansState(nextPlans);
      saveCartBundle(next, nextPlans);
      return next;
    });
  }

  function replaceCart(keys) {
    const valid = new Set(PRODUCTS.map((p) => p.key));
    const seen = new Set();
    const next = (Array.isArray(keys) ? keys : [])
      .filter((key) => typeof key === "string" && valid.has(key) && !seen.has(key) && seen.add(key));
    const currentPlans = loadCartPlans();
    const nextPlans = {};
    next.forEach((key) => {
      if (!hasProductPlans(key)) return;
      const plan = getProductPlan(key, currentPlans[key] || getDefaultProductPlan(key));
      if (plan) nextPlans[key] = plan.id;
    });
    setCartState(next);
    setCartPlansState(nextPlans);
    saveCartBundle(next, nextPlans);
  }

  function clearCart() {
    setCartState([]);
    setCartPlansState({});
    saveCartBundle([], {});
  }

  return { cart, cartPlans, hydrated, addToCart, removeFromCart, toggleCart, replaceCart, clearCart, setCartPlan };
}
