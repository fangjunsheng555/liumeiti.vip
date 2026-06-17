import { getServerLocale } from "../lib/i18n-server";

export async function generateMetadata() {
  const en = (await getServerLocale()) === "en";
  return {
    title: en ? "Secure checkout" : "安全结算",
    description: en
      ? "Confirm your selected services, fill in order details and pay via Alipay, USDT or account balance."
      : "确认已选服务、填写订单资料并选择支付宝、USDT 或账户余额等支付方式。",
    alternates: { canonical: "/checkout" },
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default function CheckoutLayout({ children }) {
  return children;
}
