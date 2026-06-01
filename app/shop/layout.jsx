export const metadata = {
  title: "服务选购",
  description: "选购 Spotify、Netflix、Disney+、HBO Max 与机场节点套餐，查看规格、价格、周期与组合优惠。",
  alternates: { canonical: "/shop" },
  openGraph: {
    title: "服务选购 | 冒央会社",
    description: "流媒体会员与节点服务套餐一站选购，价格透明，订单可查。",
    url: "/shop",
    images: [{ url: "/logo-mark.png?v=20260602", width: 384, height: 384, type: "image/png", alt: "冒央会社" }],
  },
  twitter: {
    card: "summary",
    title: "服务选购 | 冒央会社",
    description: "查看冒央会社流媒体会员与节点服务套餐。",
    images: ["/logo-mark.png?v=20260602"],
  },
};

export default function ShopLayout({ children }) {
  return children;
}
