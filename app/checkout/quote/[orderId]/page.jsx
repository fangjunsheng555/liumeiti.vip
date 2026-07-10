import ProxyQuotePayment from "../../../components/ProxyQuotePayment";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "代付报价付款 | 冒央会社",
  robots: { index: false, follow: false },
};

export default async function QuotePaymentPage({ params }) {
  const { orderId } = await params;
  return <ProxyQuotePayment orderId={String(orderId || "")} />;
}
