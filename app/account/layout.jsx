const inviteTitle = "合伙人计划 | 冒央会社";
const inviteDescription = "我发现一家性价比与服务很好的流媒体会员平台，邀请你也试试，Spotify、Netflix、Disney+、HBO Max 与机场节点服务，一站下单，售后在线";

export const metadata = {
  title: inviteTitle,
  description: inviteDescription,
  alternates: {
    canonical: "/account",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: "/account",
    siteName: "冒央会社",
    title: inviteTitle,
    description: inviteDescription,
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "冒央会社流媒体会员服务",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: inviteTitle,
    description: inviteDescription,
    images: ["/og-image.png"],
  },
};

export default function AccountLayout({ children }) {
  return children;
}
