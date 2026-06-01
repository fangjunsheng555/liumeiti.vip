const siteUrl = "https://liumeiti.vip";
const inviteTitle = "合伙人计划 | 冒央会社";
const inviteDescription = "所有流媒体及配套服务一站搞定，包使用，全年无休在线客服，价格透明，售后稳定";
const inviteImage = `${siteUrl}/icon-512.png?v=20260601`;

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
        url: inviteImage,
        width: 512,
        height: 512,
        type: "image/png",
        alt: "冒央会社",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: inviteTitle,
    description: inviteDescription,
    images: [inviteImage],
  },
};

export default function AccountLayout({ children }) {
  return children;
}
