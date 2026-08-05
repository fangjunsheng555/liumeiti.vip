import { adminPermissionProfile, adminSessionFromRequest } from "../../../_utils.js";
import { buildMailAudience } from "../audience-data.js";

export const runtime = "nodejs";

export async function POST(request) {
  const session = adminSessionFromRequest(request);
  if (!session) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const permissions = adminPermissionProfile(session);
  if (!permissions.canSendMail) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body = {};
  try { body = await request.json(); } catch {}
  const definition = body.segment ?? body.definition ?? {};
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return Response.json({ ok: false, error: "invalid_segment" }, { status: 400 });
  }
  const requestedLimit = body.limit == null || body.limit === "" ? 500 : Number(body.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 2000) {
    return Response.json({ ok: false, error: "invalid_recipient_limit" }, { status: 400 });
  }
  try {
    const audience = await buildMailAudience({
      definition,
      manualEmails: body.manualRecipients,
      maxRecipients: requestedLimit,
    });
    const visibleAudience = permissions.canViewOrders ? audience : { ...audience, sample: [], excluded: [] };
    return Response.json({ ok: true, audience: visibleAudience });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || "audience_unavailable" }, { status: error?.status === 400 ? 400 : 503 });
  }
}
