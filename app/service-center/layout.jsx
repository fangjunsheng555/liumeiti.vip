import { SOCIAL_DESCRIPTION, SOCIAL_DESCRIPTION_EN, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../social-meta";
import { getServerLocale } from "../lib/i18n-server";

export async function generateMetadata() {
  const en = (await getServerLocale()) === "en";
  const title = en ? "Service Center" : "服务中心";
  const ogTitle = en ? "Service Center | Maoyang Taiwan Inc" : "服务中心 | 冒央会社";
  const description = en ? SOCIAL_DESCRIPTION_EN : SOCIAL_DESCRIPTION;
  return {
    title,
    description,
    alternates: { canonical: "/service-center" },
    openGraph: {
      title: ogTitle,
      description,
      url: "/service-center",
      locale: en ? "en_US" : "zh_CN",
      images: [SOCIAL_IMAGE_META],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
      images: [SOCIAL_IMAGE],
    },
  };
}

export default function ServiceCenterLayout({ children }) {
  return children;
}
