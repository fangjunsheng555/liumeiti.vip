const ORDERS_KEY = "liumeiti:orders";

function clean(value, limit = 200) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

function normalizeOrderId(value) {
  return clean(value, 80).replace(/\s+/g, "").toUpperCase();
}

function normalizeContact(value) {
  return clean(value, 160).toLowerCase().replace(/[\s\-_:：()（）]/g, "");
}

function normalizeEmail(value) {
  return clean(value, 200).toLowerCase().trim();
}

function subscriptionLinks(username) {
  const encoded = encodeURIComponent(clean(username, 80));
  return {
    shadowrocket: "https://hk.joinvip.vip:2056/sub/" + encoded,
    clash: "https://hk.joinvip.vip:2056/sub/" + encoded + "?format=clash",
  };
}

function parseQuery(request, body) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    return clean(url.searchParams.get("query") || url.searchParams.get("q") || "", 160);
  }
  return clean(body.query || body.q || "", 160);
}

function idMatches(order, rawQuery) {
  const queryId = normalizeOrderId(rawQuery);
  return !!queryId && normalizeOrderId(order.orderId) === queryId;
}

function contactMatches(order, rawQuery) {
  const queryContact = normalizeContact(rawQuery);
  return !!queryContact && normalizeContact(order.contact) === queryContact;
}

function emailMatches(order, rawQuery) {
  const queryEmail = normalizeEmail(rawQuery);
  if (!queryEmail || !queryEmail.includes("@")) return false;
  return normalizeEmail(order.email) === queryEmail;
}

function orderMatches(order, query) {
  return idMatches(order, query) || emailMatches(order, query) || contactMatches(order, query);
}

function matchType(order, query) {
  if (idMatches(order, query)) return "orderId";
  if (emailMatches(order, query)) return "email";
  if (contactMatches(order, query)) return "contact";
  return "";
}

function publicOrder(order, type) {
  const output = {
    matchType: type || "",
    orderId: order.orderId || "",
    createdAt: order.createdAt || "",
    createdAtBeijing: order.createdAtBeijing || "",
    service: order.service || "",
    serviceLabel: order.serviceLabel || "",
    cycle: order.cycle || "",
    paymentMethod: order.paymentMethod || "alipay",
    originalAmount: Number(order.originalAmount || 0),
    finalAmount: Number(order.finalAmount || 0),
    currency: order.currency || "CNY",
    account: order.account || "",
    password: order.password || "",
    email: order.email || "",
    contact: order.contact || "",
    remark: order.remark || "",
  };
  if (output.service === "rocket" && output.account) {
    output.subscriptionLinks = subscriptionLinks(output.account);
  }
  return output;
}

async function readBody(request) {
  if (request.method === "GET") return {};
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

async function handle(request) {
  const body = await readBody(request);
  const query = parseQuery(request, body);
  const headers = { "Cache-Control": "no-store, max-age=0" };

  if (!query) {
    return Response.json({ ok: false, error: "query_required" }, { status: 400, headers });
  }

  const redis = redisConfig();
  if (!redis) {
    return Response.json({ ok: true, configured: false, orders: [] }, { headers });
  }

  try {
    const response = await fetch(redis.url + "/lrange/" + encodeURIComponent(ORDERS_KEY) + "/0/199", {
      headers: { Authorization: "Bearer " + redis.token },
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      return Response.json({ ok: false, error: "storage_read_failed" }, { status: 502, headers });
    }

    const orders = Array.isArray(data.result)
      ? data.result.map((item) => {
          try { return JSON.parse(item); } catch (error) { return null; }
        }).filter(Boolean)
      : [];

    const matched = orders
      .filter((order) => orderMatches(order, query))
      .slice(0, 10)
      .map((order) => publicOrder(order, matchType(order, query)));

    return Response.json({ ok: true, configured: true, orders: matched }, { headers });
  } catch (error) {
    return Response.json({ ok: false, error: "storage_unavailable" }, { status: 502, headers });
  }
}

export async function GET(request) {
  return handle(request);
}

export async function POST(request) {
  return handle(request);
}
