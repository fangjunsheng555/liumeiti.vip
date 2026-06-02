import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../social-meta";

const inviteTitle = "账户中心与合伙人计划";
const inviteDescription = SOCIAL_DESCRIPTION;
const inviteImage = SOCIAL_IMAGE;

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
        ...SOCIAL_IMAGE_META,
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
