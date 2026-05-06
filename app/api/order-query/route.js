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
  // Normalize items array (new schema). Backward-compat: synthesize from flat fields.
  let items;
  if (Array.isArray(order.items) && order.items.length > 0) {
    items = order.items.map((it) => {
      // After staff completes order, prefer staff-filled credentials
      const account = it.staffAccount || it.account || "";
      const password = it.staffPassword || it.password || "";
      const out = {
        service: it.service || "",
        label: it.label || "",
        cycle: it.cycle || "",
        amount: Number(it.amount || 0),
        account,
        password,
      };
      if (it.service === "rocket") {
        // Always derive from orderId (new scheme); fall back to stored links if present
        out.subscriptionLinks = subscriptionLinks(order.orderId) || it.subscriptionLinks;
      } else if (it.subscriptionLinks) {
        out.subscriptionLinks = it.subscriptionLinks;
      }
      return out;
    });
  } else {
    // legacy single-item order
    const it = {
      service: order.service || "",
      label: order.serviceLabel || "",
      cycle: order.cycle || "",
      amount: Number(order.finalAmount || 0),
      account: order.account || "",
      password: order.password || "",
    };
    if (it.service === "rocket") {
      it.subscriptionLinks = subscriptionLinks(order.orderId);
    }
    items = [it];
  }

  const output = {
    matchType: type || "",
    orderId: order.orderId || "",
    status: order.status || "received",
    createdAt: order.createdAt || "",
    createdAtBeijing: order.createdAtBeijing || "",
    completedAtBeijing: order.completedAtBeijing || "",
    staffNotes: order.staffNotes || "",
    items,
    itemCount: items.length,
    serviceLabel: order.serviceLabel || items.map((i) => i.label).join(" + "),
    paymentMethod: order.paymentMethod || "alipay",
    redeemCode: order.redeemCode || "",
    subtotal: Number(order.subtotal || order.originalAmount || items.reduce((s, i) => s + i.amount, 0)),
    discountRate: Number(order.discountRate || 0),
    discountLabel: order.discountLabel || "",
    finalAmount: Number(order.finalAmount || 0),
    finalUsdt: Number(order.finalUsdt || 0),
    paidAmount: Number(order.paidAmount || (order.paymentMethod === "usdt" ? order.finalUsdt : order.finalAmount) || 0),
    paidCurrency: order.paidCurrency || (order.paymentMethod === "usdt" ? "USDT" : "CNY"),
    email: order.email || "",
    contact: order.contact || "",
    remark: order.remark || "",
    // Legacy flat fields (kept for compat)
    service: items[0]?.service || "",
    cycle: items[0]?.cycle || "",
    account: items[0]?.account || "",
    password: items[0]?.password || "",
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
