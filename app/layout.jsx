import './globals.css';
import ReferralTracker from './components/ReferralTracker';

const siteUrl = 'https://www.liumeiti.vip';
const siteTitle = '冒央会社 - 流媒体会员服务';
const siteDescription = '冒央会社 Maoyang Taiwan Inc，提供 Spotify、Netflix、Disney+、HBO Max、机场节点等流媒体会员服务，支持支付宝担保支付、USDT 支付、订单查询与在线客服售后。';
const socialDescription = '流媒体会员与配套服务一站选购，价格透明，订单可查，在线客服持续跟进售后。';
const socialImage = `${siteUrl}/icon-512.png?v=20260601`;

export const metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: '%s | 冒央会社',
  },
  description: siteDescription,
  applicationName: '冒央会社',
  keywords: [
    '冒央会社',
    'liumeiti.vip',
    '流媒体会员',
    'Spotify会员',
    'Netflix会员',
    'Disney+会员',
    'HBO Max会员',
    '机场节点',
    '流媒体合租',
  ],
  authors: [{ name: 'Maoyang Taiwan Inc' }],
  creator: 'Maoyang Taiwan Inc',
  publisher: 'Maoyang Taiwan Inc',
  alternates: {
    canonical: '/',
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    shortcut: [{ url: '/favicon.ico', sizes: 'any' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  manifest: '/manifest.json',
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    url: '/',
    siteName: '冒央会社',
    title: siteTitle,
    description: socialDescription,
    images: [
      {
        url: socialImage,
        width: 512,
        height: 512,
        type: 'image/png',
        alt: '冒央会社',
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: siteTitle,
    description: socialDescription,
    images: [socialImage],
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>
        <ReferralTracker />
        {children}
      </body>
    </html>
  );
}
