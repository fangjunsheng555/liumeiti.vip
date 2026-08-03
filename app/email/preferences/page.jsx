import Link from "next/link";
import { getMailPreferencesByToken } from "../../api/_mail-preferences.js";
import PreferenceForm from "./PreferenceForm.jsx";

export const metadata = { title: "邮件偏好 | Email preferences", referrer: "no-referrer", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function EmailPreferencesPage({ searchParams }) {
  const query = await searchParams;
  const token = String(query?.token || "");
  const result = token ? await getMailPreferencesByToken(token) : { ok: false, error: "token_required" };
  const en = result.locale === "en";
  const L = (zh, english) => en ? english : zh;
  const temporarilyUnavailable = result.error === "storage_unavailable" || result.error === "storage_failed";
  return <main style={{ minHeight: "100vh", background: "linear-gradient(180deg,#edf7f4 0,#f8faf9 45%,#fff 100%)", padding: "48px 18px", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif" }}>
    <section style={{ maxWidth: 590, margin: "0 auto", background: "white", border: "1px solid #dce8e5", borderRadius: 24, padding: "32px clamp(20px,5vw,42px)", boxShadow: "0 18px 50px rgba(18,60,56,.09)" }}>
      <Link href="/" referrerPolicy="no-referrer" style={{ color: "#08786c", textDecoration: "none", fontWeight: 800, letterSpacing: ".04em" }}>冒央会社</Link>
      <h1 style={{ color: "#123c38", fontSize: 28, lineHeight: 1.25, margin: "24px 0 8px" }}>{L("管理邮件偏好", "Manage email preferences")}</h1>
      <p style={{ color: "#71807e", fontSize: 14, lineHeight: 1.7, margin: 0 }}>{L("分别选择你希望收到的邮件，不再需要通过回复“退订”处理。", "Choose which emails you want to receive. You no longer need to reply to unsubscribe.")}</p>
      {temporarilyUnavailable
        ? <div role="alert" style={{ marginTop: 24, borderRadius: 14, background: "#fff8e8", color: "#7a4b00", padding: 18, fontSize: 14, lineHeight: 1.7 }}>{L("系统暂时无法读取邮件偏好，请稍后刷新。本次未修改您的设置。", "Email preferences are temporarily unavailable. Please refresh later; your settings were not changed.")}</div>
        : result.ok
        ? <PreferenceForm
            token={token}
            initialPreferences={result.preferences}
            initialSuppression={result.suppression}
            maskedEmail={result.maskedEmail}
            locale={result.locale}
          />
        : <div role="alert" style={{ marginTop: 24, borderRadius: 14, background: "#fff4f2", color: "#9f2d20", padding: 18, fontSize: 14, lineHeight: 1.7 }}>{L("链接无效或已过期。请使用最近一封邮件底部的“管理邮件偏好”，或登录账户后修改设置。", "This link is invalid or expired. Use “Manage email preferences” in your most recent email, or sign in to update your settings.")}</div>}
      <div style={{ marginTop: 26, textAlign: "center" }}><Link href="/" referrerPolicy="no-referrer" style={{ color: "#687b78", fontSize: 13 }}>{L("返回网站", "Return to website")}</Link></div>
    </section>
  </main>;
}
