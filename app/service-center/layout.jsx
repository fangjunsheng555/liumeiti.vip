import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../social-meta";

export const metadata = {
  title: "服务中心",
  description: SOCIAL_DESCRIPTION,
  alternates: { canonical: "/service-center" },
  openGraph: {
    title: "服务中心 | 冒央会社",
    description: SOCIAL_DESCRIPTION,
    url: "/service-center",
    images: [SOCIAL_IMAGE_META],
  },
  twitter: {
    card: "summary",
    title: "服务中心 | 冒央会社",
    description: SOCIAL_DESCRIPTION,
    images: [SOCIAL_IMAGE],
  },
};

export default function ServiceCenterLayout({ children }) {
  return children;
}
