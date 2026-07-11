import SpotifyPasswordUpdate from "../../../components/SpotifyPasswordUpdate";

export const dynamic = "force-dynamic";

export const metadata = {
  title: { absolute: "Spotify 订单资料更正 | 冒央会社" },
  robots: { index: false, follow: false },
};

export default async function SpotifyPasswordUpdatePage({ params }) {
  const { orderId } = await params;
  return <SpotifyPasswordUpdate orderId={String(orderId || "")} />;
}
