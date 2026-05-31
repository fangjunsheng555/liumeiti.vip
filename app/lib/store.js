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
    subtitle: "欧美日家庭无损播客",
    amount: 128,
    cycle: "1年",
    price: "仅需¥128/年",
    shortIntro: "无损音质，播客，AIDJ，完整曲库，有声读物，合辑歌单等",
    highlights: ["功能齐全", "稳定使用", "售后保障"],
    detailTitle: "欧美日高价区家庭计划，一年仅128元包售后",
    detailBody:
      "支持无损音质，收听播客，离线下载，合辑歌单，有声读物，曲库完整，如需订阅个人/双人/六人家庭请联系在线客服",
    orderTitle: "Spotify · 支付宝扫码支付 ¥128",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "netflix",
    image: "/products/netflix.jpg",
    title: "Netflix",
    subtitle: "全球可用4K杜比独立车位",
    amount: 168,
    cycle: "1年",
    price: "仅需¥168/年",
    shortIntro: "全球可用顶规套餐，4K画质，杜比音效，一人一位可上锁",
    highlights: ["4K画质", "杜比音效", "售后保障"],
    detailTitle: "最高级别套餐，独立车位，一年仅168包售后",
    detailBody:
      "4K杜比最高级别套餐，高峰不排队不被挤，一人独享一个位置，最高4K画质，支持杜比音效，离线下载，位置可上pin，五人一车一人一位互不干扰，如需购买整号请联系在线客服",
    orderTitle: "Netflix · 支付宝扫码支付 ¥168",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "disney",
    image: "/products/disney.jpg",
    title: "Disney+",
    subtitle: "独立车位全球可用4K杜比套餐",
    amount: 108,
    cycle: "1年",
    price: "仅需¥108/年",
    shortIntro: "全球可用4K杜比套餐，一人一位置互不干扰，绝不超售",
    highlights: ["4K杜比", "位置上锁", "不被挤不排队"],
    detailTitle: "最高级别套餐，独立车位，一年仅108包售后",
    detailBody:
      "4K画质，杜比音效，离线下载，全球可用不限制地区，顶规4K杜比套餐，绝不超售，高峰不排队不被挤，一人一位置可上锁，用户互不干扰，如需购买整号请联系在线客服",
    orderTitle: "Disney+ · 支付宝扫码支付 ¥108",
    orderBody:
      "填写联系方式并完成支付宝付款，提交订单后充值人员将在30分钟内联系您",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "max",
    image: "/products/hbomax.jpg",
    title: "HBO Max",
    subtitle: "独立车位全球可用4K杜比套餐",
    amount: 148,
    cycle: "1年",
    price: "仅需¥148/年",
    shortIntro: "全球可用4K杜比套餐，一人独享一位置互不干扰高峰不排队",
    highlights: ["4K杜比", "全球可用", "实时售后保障"],
    detailTitle: "最高级别套餐，独立车位，一年仅148包售后",
    detailBody:
      "4K画质，杜比音效，离线下载，全球可用不限制地区，顶规4K杜比套餐，绝不超售，高峰不排队不被挤，一人一位置可上锁，用户互不干扰，如需购买整号请联系在线客服",
    orderTitle: "HBO Max · 支付宝扫码支付 ¥148",
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
      "请在支付完成后点击付款完成提交订单，系统自动将为你生成订阅链接",
    qrImage: "/payment/alipay.jpg",
  },
];

export const ROCKET_PLANS = {
  basic: { id: "basic", label: "普通套餐", amount: 128, desc: "50 GB/月真实流量" },
  pro: { id: "pro", label: "高级套餐", amount: 198, desc: "100 GB/月真实流量" },
  luxury: { id: "luxury", label: "豪华套餐", amount: 398, desc: "200 GB/月真实流量" },
  unlimited: { id: "unlimited", label: "无限套餐", amount: 698, desc: "无限流量" },
  trial: { id: "trial", label: "5元10GB测试", amount: 5, desc: "10 GB测试流量", unit: "次", cycle: "次", requiresLogin: true, onePerUser: true },
};
export const DEFAULT_ROCKET_PLAN = "basic";

export function getRocketPlan(planId) {
  const aliases = { single: "basic" };
  const id = aliases[planId] || planId;
  return ROCKET_PLANS[id] || ROCKET_PLANS[DEFAULT_ROCKET_PLAN];
}

export function rocketPlanLabel(planId) {
  return getRocketPlan(planId).label;
}

export function productItemAmount(product, plan) {
  if (!product) return 0;
  if (product.key === "rocket") return getRocketPlan(plan).amount;
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
    if (parsed.rocket && ROCKET_PLANS[parsed.rocket]) next.rocket = parsed.rocket;
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
    if (key !== "rocket" || !ROCKET_PLANS[planId]) return;
    const next = { ...loadCartPlans(), [key]: planId };
    setCartPlansState(next);
    saveCartPlans(next);
  }

  function addToCart(key, options = {}) {
    setCartState((current) => {
      const next = current.includes(key) ? current : [...current, key];
      const nextPlans = { ...loadCartPlans() };
      if (key === "rocket" && ROCKET_PLANS[options.plan]) nextPlans.rocket = options.plan;
      setCartPlansState(nextPlans);
      saveCartBundle(next, nextPlans);
      return next;
    });
  }

  function removeFromCart(key) {
    setCartState((current) => {
      const next = current.filter((k) => k !== key);
      const nextPlans = { ...loadCartPlans() };
      if (key === "rocket") {
        delete nextPlans.rocket;
      }
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
      if (key === "rocket") {
        if (removing) delete nextPlans.rocket;
        else nextPlans.rocket = ROCKET_PLANS[options.plan] ? options.plan : DEFAULT_ROCKET_PLAN;
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
    if (next.includes("rocket") && currentPlans.rocket) nextPlans.rocket = currentPlans.rocket;
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
