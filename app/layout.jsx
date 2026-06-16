import './globals.css';
import './portal-theme.css';
import ReferralTracker from './components/ReferralTracker';
import { LocaleProvider } from './components/LocaleProvider';
import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from './social-meta';

const siteUrl = 'https://www.liumeiti.vip';
const siteTitle = '冒央会社 - 流媒体会员服务';
const siteDescription = SOCIAL_DESCRIPTION;
const socialDescription = SOCIAL_DESCRIPTION;
const socialImage = SOCIAL_IMAGE;

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
        ...SOCIAL_IMAGE_META,
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
        <link rel="preload" href="/fonts/inter-400.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/inter-600.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <ReferralTracker />
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
