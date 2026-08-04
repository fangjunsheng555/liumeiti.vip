import { unsubscribeMailToken } from "../../_mail-preferences.js";

export const runtime = "nodejs";

const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };

function tokenFrom(request, body = "") {
  const url = new URL(request.url);
  const params = new URLSearchParams(body);
  return String(url.searchParams.get("token") || params.get("token") || "").trim();
}

// Safe GET: scanners and link previews must never change subscription state.
export async function GET(request) {
  const token = tokenFrom(request);
  const origin = new URL(request.url).origin;
  const target = `${origin}/email/unsubscribe${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  return new Response(null, { status: 303, headers: { ...noStore, location: target } });
}

// RFC 8058 one-click endpoint. The provider posts
// `List-Unsubscribe=One-Click`; repeated requests remain idempotent.
export async function POST(request) {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  const body = (await request.text()).slice(0, 4096);
  const params = new URLSearchParams(body);
  if (contentType.split(";", 1)[0].trim() !== "application/x-www-form-urlencoded") {
    return Response.json({ ok: false, error: "unsupported_content_type" }, { status: 415, headers: noStore });
  }
  if (params.get("List-Unsubscribe") !== "One-Click") {
    return Response.json({ ok: false, error: "invalid_one_click_request" }, { status: 400, headers: noStore });
  }
  const token = tokenFrom(request, body);
  if (!token) return Response.json({ ok: false, error: "token_required" }, { status: 400, headers: noStore });
  const result = await unsubscribeMailToken(token, "rfc8058");
  if (!result.ok) {
    const status = ["storage_unavailable", "storage_failed"].includes(result.error)
      ? 503
      : (result.error === "contact_repair_required" ? 409 : (result.error === "invalid_token" ? 400 : 404));
    return Response.json({ ok: false, error: result.error, retryable: Boolean(result.retryable) }, { status, headers: noStore });
  }
  return Response.json({ ok: true, unsubscribed: true }, { headers: noStore });
}
