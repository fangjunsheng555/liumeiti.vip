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
    subtitle: "4K杜比套餐，独立车位",
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
    subtitle: "不限设备·不限流量·最高5Gbps·解锁全球平台",
    amount: 98,
    cycle: "1年",
    needsUsername: true,
    price: "仅需¥98/年",
    shortIntro: "大厂机房多线路，最高5Gbps带宽，解锁所有流媒体/AI/社交软件，高峰不卡顿",
    highlights: ["不限设备/流量", "高速稳定多节点", "全加密无日志"],
    detailTitle: "大厂机房多线路，不限设备不限流量，年仅¥98",
    detailBody:
      "优选大厂VPS，多线路港日台韩新美英德法等，不限制设备，不限制流量，最高速率可达5Gbps，高峰不拥堵不卡顿，解锁所有主流流媒体/AI软件/社交软件，全加密协议无日志隐私保障，实时维护24×7线路不中断",
    orderTitle: "机场节点 · 支付宝扫码支付 ¥98",
    orderBody:
      "请在支付完成后点击付款完成提交订单，系统自动将为你生成订阅链接。",
    qrImage: "/payment/alipay.jpg",
  },
];

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

export function cartSubtotalCny(items) {
  return items.reduce((sum, p) => sum + (p?.amount || 0), 0);
}

export function cartFinalCny(items) {
  const subtotal = cartSubtotalCny(items);
  const rate = bundleDiscountRate(items.length);
  return Math.round(subtotal * (1 - rate));
}

export function cartFinalUsdt(items) {
  const cny = cartFinalCny(items);
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

function saveCart(cart) {
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    window.dispatchEvent(new Event(CART_EVENT));
  } catch {}
}

export function useCart() {
  const [cart, setCartState] = useState([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setCartState(loadCart());
    setHydrated(true);
    const sync = () => setCartState(loadCart());
    window.addEventListener(CART_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CART_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  function addToCart(key) {
    setCartState((current) => {
      if (current.includes(key)) return current;
      const next = [...current, key];
      saveCart(next);
      return next;
    });
  }

  function removeFromCart(key) {
    setCartState((current) => {
      const next = current.filter((k) => k !== key);
      saveCart(next);
      return next;
    });
  }

  function toggleCart(key) {
    setCartState((current) => {
      const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
      saveCart(next);
      return next;
    });
  }

  function clearCart() {
    setCartState([]);
    saveCart([]);
  }

  return { cart, hydrated, addToCart, removeFromCart, toggleCart, clearCart };
}
