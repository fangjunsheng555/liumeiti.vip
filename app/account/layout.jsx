const siteUrl = "https://www.liumeiti.vip";
const inviteTitle = "账户中心与合伙人计划";
const inviteDescription = "登录冒央会社账户，查看订单、余额、优惠券、提现与合伙人邀请记录。";
const inviteImage = `${siteUrl}/logo-mark.png?v=20260602`;

export const metadata = {
  title: inviteTitle,
  description: inviteDescription,
  alternates: {
    canonical: "/account",
  },
  robots: {
    index: false,
    follow: false,
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
        width: 384,
        height: 384,
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
