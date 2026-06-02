import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from "../social-meta";

export const metadata = {
  title: "服务选购",
  description: SOCIAL_DESCRIPTION,
  alternates: { canonical: "/shop" },
  openGraph: {
    title: "服务选购 | 冒央会社",
    description: SOCIAL_DESCRIPTION,
    url: "/shop",
    images: [SOCIAL_IMAGE_META],
  },
  twitter: {
    card: "summary",
    title: "服务选购 | 冒央会社",
    description: SOCIAL_DESCRIPTION,
    images: [SOCIAL_IMAGE],
  },
};

export default function ShopLayout({ children }) {
  return children;
}
