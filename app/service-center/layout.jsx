export const metadata = {
  title: "服务中心",
  description: "通过邮箱验证码安全查询冒央会社订单状态，查看售后保障、常见问题与在线客服联系方式。",
  alternates: { canonical: "/service-center" },
  openGraph: {
    title: "服务中心 | 冒央会社",
    description: "订单查询、售后支持、服务保障与客服联系方式。",
    url: "/service-center",
    images: [{ url: "/icon-512.png?v=20260601", width: 512, height: 512, type: "image/png", alt: "冒央会社" }],
  },
  twitter: {
    card: "summary",
    title: "服务中心 | 冒央会社",
    description: "安全查询订单状态并联系冒央会社客服。",
    images: ["/icon-512.png?v=20260601"],
  },
};

export default function ServiceCenterLayout({ children }) {
  return children;
}
