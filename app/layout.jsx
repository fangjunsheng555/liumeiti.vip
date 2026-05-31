import './globals.css';

const siteUrl = 'https://liumeiti.vip';
const siteTitle = '冒央会社-流媒体会员服务';
const siteDescription = '冒央会社 Maoyang Taiwan Inc，提供 Spotify、Netflix、Disney+、HBO Max、机场节点等流媒体会员服务，支持支付宝担保支付、USDT 支付、订单查询与在线客服售后';

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
    description: siteDescription,
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: '冒央会社流媒体会员服务',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: siteTitle,
    description: siteDescription,
    images: ['/og-image.png'],
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
      <body>{children}</body>
    </html>
  );
}
