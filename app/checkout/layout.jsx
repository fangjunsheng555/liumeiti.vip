export const metadata = {
  title: "安全结算",
  description: "确认已选服务、填写订单资料并选择支付宝、USDT 或账户余额等支付方式。",
  alternates: { canonical: "/checkout" },
  robots: {
    index: false,
    follow: false,
  },
};

export default function CheckoutLayout({ children }) {
  return children;
}
