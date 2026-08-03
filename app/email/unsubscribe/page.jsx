import Link from "next/link";
import { getMailPreferencesByToken } from "../../api/_mail-preferences.js";
import UnsubscribeConfirmation from "./UnsubscribeConfirmation.jsx";

export const metadata = {
  title: "退订营销邮件 | Unsubscribe from marketing",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function EmailUnsubscribePage({ searchParams }) {
  const query = await searchParams;
  const token = String(query?.token || "");
  // Reading the landing page is deliberately side-effect free. Mail scanners,
  // link previews and security gateways must never unsubscribe a recipient.
  const result = token ? await getMailPreferencesByToken(token) : { ok: false, error: "token_required" };
  const en = result.locale === "en";
  const L = (zh, english) => en ? english : zh;
  const temporarilyUnavailable = result.error === "storage_unavailable" || result.error === "storage_failed";
  const initiallyUnsubscribed = result.preferences?.marketing === "denied"
    || (result.suppression?.scope === "marketing" && result.suppression?.reason === "marketing_unsubscribed");

  return <main style={{ minHeight: "100vh", background: "linear-gradient(180deg,#edf7f4 0,#f8faf9 45%,#fff 100%)", padding: "48px 18px", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif" }}>
    <section style={{ maxWidth: 540, margin: "0 auto", background: "white", border: "1px solid #dce8e5", borderRadius: 24, padding: "32px clamp(20px,5vw,42px)", boxShadow: "0 18px 50px rgba(18,60,56,.09)" }}>
      <Link href="/" referrerPolicy="no-referrer" style={{ color: "#08786c", textDecoration: "none", fontWeight: 800, letterSpacing: ".04em" }}>冒央会社</Link>
      <div aria-hidden="true" style={{ width: 48, height: 48, display: "grid", placeItems: "center", marginTop: 24, borderRadius: 15, background: "#e8f6f2", color: "#08786c", fontSize: 24 }}>✉</div>
      <h1 style={{ color: "#123c38", fontSize: 28, lineHeight: 1.25, margin: "18px 0 8px" }}>{L("确认退订营销邮件", "Confirm marketing unsubscribe")}</h1>
      <p style={{ color: "#71807e", fontSize: 14, lineHeight: 1.75, margin: 0 }}>
        {L("确认后，我们将不再向此邮箱发送优惠、活动与新品推荐。订单进度、验证码和账户安全邮件不受影响。", "After confirmation, we will stop sending offers, promotions and new-service recommendations. Order, verification and account-security email is unaffected.")}
      </p>
      {result.ok ? <p style={{ color: "#526663", fontSize: 13, margin: "16px 0 0" }}>{L("邮箱：", "Email: ")}{result.maskedEmail}</p> : null}
      {temporarilyUnavailable
        ? <div role="alert" style={{ marginTop: 24, borderRadius: 14, background: "#fff8e8", color: "#7a4b00", padding: 18, fontSize: 14, lineHeight: 1.7 }}>{L("系统暂时无法读取退订状态，请稍后刷新。本次未修改您的订阅。", "Unsubscribe status is temporarily unavailable. Please refresh later; your subscription was not changed.")}</div>
        : result.ok
          ? <UnsubscribeConfirmation token={token} locale={result.locale} initiallyUnsubscribed={initiallyUnsubscribed} />
          : <div role="alert" style={{ marginTop: 24, borderRadius: 14, background: "#fff4f2", color: "#9f2d20", padding: 18, fontSize: 14, lineHeight: 1.7 }}>{L("链接无效或已过期。请使用最近一封邮件底部的退订链接。", "This link is invalid or expired. Use the unsubscribe link in your most recent email.")}</div>}
      <div style={{ marginTop: 26, textAlign: "center" }}><Link href="/" referrerPolicy="no-referrer" style={{ color: "#687b78", fontSize: 13 }}>{L("暂不退订，返回网站", "Keep subscribed and return")}</Link></div>
    </section>
  </main>;
}
