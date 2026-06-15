import Link from "next/link";

export const metadata = {
  title: "页面未找到",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <div className="page-shell home-page-shell">
      <main
        className="main-content"
        style={{ minHeight: "82vh", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div className="container" style={{ textAlign: "center", padding: "48px 20px" }}>
          <img
            src="/logo-transparent.png"
            alt="冒央会社 Maoyang Taiwan Inc"
            style={{ width: 220, maxWidth: "72%", height: "auto", margin: "0 auto 26px", display: "block" }}
          />
          <div
            style={{
              fontSize: 72,
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: "-0.04em",
              background: "linear-gradient(135deg, #0f766e, #14b8a6)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            404
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: "14px 0 6px", color: "#1d1d1f" }}>
            页面未找到
          </h1>
          <p style={{ color: "#6e6e73", margin: "0 0 26px", fontSize: 15 }}>
            抱歉，你访问的页面不存在或已移动
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                background: "linear-gradient(135deg, #0f766e, #14b8a6)",
                color: "#fff",
                padding: "12px 26px",
                borderRadius: 980,
                fontWeight: 500,
                fontSize: 15,
                textDecoration: "none",
                boxShadow: "0 10px 24px -12px rgba(15,118,110,0.7)",
              }}
            >
              返回首页
            </Link>
            <Link
              href="/shop"
              style={{
                display: "inline-flex",
                alignItems: "center",
                background: "#fff",
                color: "#1d1d1f",
                padding: "12px 26px",
                borderRadius: 980,
                fontWeight: 500,
                fontSize: 15,
                textDecoration: "none",
                border: "1px solid rgba(0,0,0,0.1)",
              }}
            >
              去选购
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
