import { SOCIAL_DESCRIPTION, SOCIAL_DESCRIPTION_EN, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../social-meta";
import { getServerLocale } from "../lib/i18n-server";

export async function generateMetadata() {
  const en = (await getServerLocale()) === "en";
  const title = en ? "Account & Partner Program" : "账户中心与合伙人计划";
  const description = en ? SOCIAL_DESCRIPTION_EN : SOCIAL_DESCRIPTION;
  return {
    title,
    description,
    alternates: { canonical: "/account" },
    robots: { index: false, follow: false },
    openGraph: {
      type: "website",
      locale: en ? "en_US" : "zh_CN",
      url: "/account",
      siteName: en ? "Maoyang Taiwan Inc" : "冒央会社",
      title,
      description,
      images: [{ ...SOCIAL_IMAGE_META }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [SOCIAL_IMAGE],
    },
  };
}

export default function AccountLayout({ children }) {
  return children;
}
