// 公开站点设置(合并默认+后台覆盖)。前端读这里,保证站点显示与邮件/结账一致。
// 不含任何密钥(Telegram token/chatId 在 env,不经此处)。
import { getSettings } from "../_settings.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getSettings();
  return Response.json({ ok: true, settings }, { headers: { "cache-control": "no-store" } });
}

export async function OPTIONS() { return new Response(null, { status: 204 }); }
