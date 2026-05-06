import { clean, getRedeemCodePublic } from "../_utils.js";

export async function GET(request) {
  const url = new URL(request.url);
  const result = await getRedeemCodePublic(url.searchParams.get("code") || "");
  if (!result.ok) {
    return Response.json({ ok: false, error: clean(result.error, 80), message: "兑换码不存在" }, { status: 404 });
  }
  return Response.json(result);
}

