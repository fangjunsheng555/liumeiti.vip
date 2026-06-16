// 服务端组件读取 locale（cookie 优先，否则按 Accept-Language 自动识别）
import { cookies, headers } from "next/headers";
import { LOCALES } from "./i18n";

export async function getServerLocale() {
  try {
    const c = await cookies();
    const cookieLoc = c.get("locale")?.value;
    if (LOCALES.includes(cookieLoc)) return cookieLoc;
  } catch (e) {}
  try {
    const h = await headers();
    const primary = (h.get("accept-language") || "").toLowerCase().split(",")[0] || "";
    if (!primary || primary.startsWith("zh")) return "zh";
    return "en";
  } catch (e) {}
  return "zh";
}
