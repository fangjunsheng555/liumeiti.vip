const ORDERS_KEY = "liumeiti:orders";

const PRODUCTS = {
  spotify: { label: "Spotify", amount: 128, cycle: "1年" },
  netflix: { label: "Netflix", amount: 168, cycle: "1年" },
  disney: { label: "Disney+", amount: 108, cycle: "1年" },
  max: { label: "HBO Max", amount: 148, cycle: "1年" },
  rocket: { label: "机场节点", amount: 98, cycle: "1年", needsUsername: true },
};

function clean(value, limit = 500) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatBeijingTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  const beijing = new Date(timestamp + 8 * 60 * 60 * 1000);
  return [
    beijing.getUTCFullYear(),
    pad2(beijing.getUTCMonth() + 1),
    pad2(beijing.getUTCDate()),
  ].join("-") + " " + [
    pad2(beijing.getUTCHours()),
    pad2(beijing.getUTCMinutes()),
    pad2(beijing.getUTCSeconds()),
  ].join(":") + " 北京时间 (UTC+8)";
}

function validUsername(value) {
  return /^[A-Za-z0-9]{4,10}$/.test(String(value || "").trim());
}

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(username);
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

async function saveOrder(order) {
  const redis = redisConfig();
  if (!redis) return null;

  try {
    const response = await fetch(redis.url + "/pipeline", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + redis.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["LPUSH", ORDERS_KEY, JSON.stringify(order)],
        ["LTRIM", ORDERS_KEY, "0", "199"],
      ]),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return Array.isArray(result) && result.every((item) => !item.error);
  } catch (error) {
    return false;
  }
}

function orderText(order) {
  const lines = [
    "新订单 " + order.orderId,
    "网站: liumeiti.vip",
    "时间: " + order.createdAtBeijing,
    "服务: " + order.serviceLabel,
    "周期: " + order.cycle,
    "支付: 支付宝",
    "应付: " + order.finalAmount + " CNY",
  ];

  if (order.service === "rocket") {
    const links = subscriptionLinks(order.account);
    lines.push("用户名: " + order.account);
    lines.push("Shadowrocket订阅: " + links.shadowrocket);
    lines.push("Clash订阅: " + links.clash);
  }

  lines.push("联系方式: " + order.contact);
  lines.push("备注: " + (order.remark || "无"));
  return lines.join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;

  const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  return response.ok;
}

async function sendWebhook(order) {
  const webhookUrl = process.env.ORDER_WEBHOOK_URL;
  if (!webhookUrl) return null;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });
  return response.ok;
}

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch (error) {
    body = {};
  }

  const service = clean(body.service, 40);
  const product = PRODUCTS[service];
  const contact = clean(body.contact, 200);
  const account = clean(body.account, 80);
  const remark = clean(body.remark, 800);

  if (!product || !contact || (product.needsUsername && !validUsername(account))) {
    return Response.json({ ok: false, error: "missing_required_fields" }, { status: 400 });
  }

  const now = new Date();
  const order = {
    orderId: "LM" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(),
    createdAt: now.toISOString(),
    createdAtBeijing: formatBeijingTime(now),
    service,
    serviceLabel: product.label,
    cycle: product.cycle,
    originalAmount: product.amount,
    finalAmount: product.amount,
    currency: "CNY",
    paymentMethod: "alipay",
    account: product.needsUsername ? account : "",
    contact,
    remark,
  };

  const text = orderText(order);
  const deliveries = [];
  const stored = await saveOrder(order);
  if (stored !== null) deliveries.push({ channel: "storage", ok: stored });

  try {
    const telegramSent = await sendTelegram(text);
    if (telegramSent !== null) deliveries.push({ channel: "telegram", ok: telegramSent });
  } catch (error) {
    deliveries.push({ channel: "telegram", ok: false });
  }

  try {
    const webhookSent = await sendWebhook(order);
    if (webhookSent !== null) deliveries.push({ channel: "webhook", ok: webhookSent });
  } catch (error) {
    deliveries.push({ channel: "webhook", ok: false });
  }

  const telegramDelivery = deliveries.find((item) => item.channel === "telegram");
  if (!telegramDelivery) {
    return Response.json({ ok: false, error: "telegram_not_configured" }, { status: 500 });
  }

  if (!telegramDelivery.ok) {
    return Response.json({ ok: false, error: "telegram_failed", orderId: order.orderId }, { status: 502 });
  }

  return Response.json({ ok: true, orderId: order.orderId, deliveries });
}
