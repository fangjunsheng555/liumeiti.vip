const MAX_RAW_BYTES = 5 * 1024 * 1024;

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes) {
  let binary = "";
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function digestHex(bytes) {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function headerValue(value, max = 500) {
  return String(value || "").replace(/[\r\n]/g, " ").slice(0, max);
}

export default {
  async email(message, env) {
    const secret = String(env.NETFLIX_EMAIL_INGEST_SECRET || "");
    if (secret.length < 32) throw new Error("NETFLIX_EMAIL_INGEST_SECRET is not configured");
    if (Number(message.rawSize || 0) > MAX_RAW_BYTES) throw new Error("Email exceeds the 5 MB ingest limit");

    const raw = await new Response(message.raw).arrayBuffer();
    if (!raw.byteLength || raw.byteLength > MAX_RAW_BYTES) throw new Error("Invalid email size");
    const timestamp = String(Date.now());
    const digest = await digestHex(raw);
    const signature = await sign(secret, `${timestamp}\n${digest}`);
    const endpoint = String(env.INGEST_ENDPOINT || "https://www.liumeiti.vip/api/webhooks/netflix-email");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "message/rfc822",
        "x-email-timestamp": timestamp,
        "x-email-signature": signature,
        "x-email-envelope-from": headerValue(message.from),
        "x-email-envelope-to": headerValue(message.to),
        "x-email-message-id": headerValue(message.headers?.get("message-id"), 300),
      },
      body: raw,
    });
    if (!response.ok) throw new Error(`Netflix email ingest failed: ${response.status}`);
  },
};
