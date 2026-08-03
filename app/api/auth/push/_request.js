export function pushMutationRequestError(request) {
  const contentType = String(request?.headers?.get?.("content-type") || "").toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    return Response.json({ ok: false, error: "json_content_type_required" }, {
      status: 415,
      headers: { "cache-control": "no-store" },
    });
  }

  let requestOrigin = "";
  try { requestOrigin = new URL(request.url).origin; } catch {}
  const suppliedOrigin = String(request?.headers?.get?.("origin") || "").trim();
  let normalizedSuppliedOrigin = "";
  if (suppliedOrigin) {
    try { normalizedSuppliedOrigin = new URL(suppliedOrigin).origin; } catch { normalizedSuppliedOrigin = "invalid"; }
  }
  if (!requestOrigin || (suppliedOrigin && normalizedSuppliedOrigin !== requestOrigin)) {
    return Response.json({ ok: false, error: "cross_origin_request" }, {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }

  const fetchSite = String(request?.headers?.get?.("sec-fetch-site") || "").trim().toLowerCase();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    return Response.json({ ok: false, error: "cross_origin_request" }, {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }
  return null;
}
