export default function Loading() {
  return (
    <div
      className="page-shell home-page-shell"
      style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ textAlign: "center" }}>
        <img
          src="/logo-transparent.png"
          alt="冒央会社"
          style={{ width: 160, maxWidth: "56%", height: "auto", opacity: 0.92, margin: "0 auto 22px", display: "block" }}
        />
        <div
          aria-label="加载中"
          role="status"
          style={{
            width: 30,
            height: 30,
            margin: "0 auto",
            border: "3px solid rgba(15,118,110,0.18)",
            borderTopColor: "#0f766e",
            borderRadius: "50%",
            animation: "portal-spin 0.8s linear infinite",
          }}
        />
      </div>
    </div>
  );
}
