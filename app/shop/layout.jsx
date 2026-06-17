import { SOCIAL_DESCRIPTION, SOCIAL_DESCRIPTION_EN, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../social-meta";
import { getServerLocale } from "../lib/i18n-server";

export async function generateMetadata() {
  const en = (await getServerLocale()) === "en";
  const title = en ? "Shop services" : "服务选购";
  const ogTitle = en ? "Shop services | Maoyang Taiwan Inc" : "服务选购 | 冒央会社";
  const description = en ? SOCIAL_DESCRIPTION_EN : SOCIAL_DESCRIPTION;
  return {
    title,
    description,
    alternates: { canonical: "/shop" },
    openGraph: {
      title: ogTitle,
      description,
      url: "/shop",
      locale: en ? "en_US" : "zh_CN",
      images: [SOCIAL_IMAGE_META],
    },
    twitter: {
      card: "summary",
      title: ogTitle,
      description,
      images: [SOCIAL_IMAGE],
    },
  };
}

export default function ShopLayout({ children }) {
  return children;
}
