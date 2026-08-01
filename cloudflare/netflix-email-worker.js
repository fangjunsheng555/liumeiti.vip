const MAX_RAW_BYTES = 5 * 1024 * 1024;
const DELIVERY_ATTEMPTS = 3;

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries transient ingest failures inside this delivery. A thrown error here
// bounces back to the forwarding mailbox, and repeated bounces are a known
// trigger for Outlook silently disabling its forwarding rules — so bouncing is
// the last resort, not the default.
async function deliverWithRetry({ secret, env, raw, envelope }) {
  const digest = await digestHex(raw);
  const endpoint = String(env.INGEST_ENDPOINT || "https://www.liumeiti.vip/api/webhooks/netflix-email");
  let lastError = null;
  for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt += 1) {
    const timestamp = String(Date.now());
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "message/rfc822",
          "x-email-timestamp": timestamp,
          "x-email-signature": await sign(secret, `${timestamp}\n${digest}`),
          "x-email-envelope-from": headerValue(envelope.from),
          "x-email-envelope-to": headerValue(envelope.to),
          "x-email-message-id": headerValue(envelope.messageId, 300),
        },
        body: raw,
      });
      if (response.ok) return;
      // 4xx (bad signature, oversized, misconfiguration) will not heal on
      // retry within this delivery; 5xx/429 are worth another attempt.
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`Netflix email ingest rejected: ${response.status}`);
      }
      lastError = new Error(`Netflix email ingest failed: ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < DELIVERY_ATTEMPTS) await wait(1500 * attempt);
  }
  throw lastError || new Error("Netflix email ingest failed");
}

export default {
  async email(message, env) {
    const secret = String(env.NETFLIX_EMAIL_INGEST_SECRET || "");
    if (secret.length < 32) throw new Error("NETFLIX_EMAIL_INGEST_SECRET is not configured");
    if (Number(message.rawSize || 0) > MAX_RAW_BYTES) throw new Error("Email exceeds the 5 MB ingest limit");

    const raw = await new Response(message.raw).arrayBuffer();
    if (!raw.byteLength || raw.byteLength > MAX_RAW_BYTES) throw new Error("Invalid email size");
    try {
      await deliverWithRetry({
        secret,
        env,
        raw,
        envelope: {
          from: message.from,
          to: message.to,
          messageId: message.headers?.get("message-id"),
        },
      });
    } catch (error) {
      // Optional safety net: a verified Email Routing destination address.
      // Forwarding there preserves the email and avoids bouncing to Outlook.
      const fallback = String(env.FALLBACK_FORWARD_ADDRESS || "").trim();
      if (fallback) {
        try {
          await message.forward(fallback);
          return;
        } catch {}
      }
      throw error;
    }
  },
};
