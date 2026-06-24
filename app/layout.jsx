import './globals.css';
import './portal-theme.css';
import ReferralTracker from './components/ReferralTracker';
import VisitTracker from './components/VisitTracker';
import AnnounceBar from './components/AnnounceBar';
import { LocaleProvider } from './components/LocaleProvider';
import { SOCIAL_DESCRIPTION, SOCIAL_IMAGE, SOCIAL_IMAGE_META } from './social-meta';
import { getServerLocale } from './lib/i18n-server';

const siteUrl = 'https://www.liumeiti.vip';
const siteTitleZh = '冒央会社 - 流媒体会员服务';
const siteTitleEn = 'Maoyang Taiwan Inc — Streaming memberships';
const siteDescEn = 'Spotify, Netflix, Disney+, HBO Max memberships and VPN service. Fast setup, escrow checkout, after-sales support.';
const socialImage = SOCIAL_IMAGE;

export async function generateMetadata() {
  const locale = await getServerLocale();
  const en = locale === 'en';
  const siteTitle = en ? siteTitleEn : siteTitleZh;
  const description = en ? siteDescEn : SOCIAL_DESCRIPTION;
  return {
    metadataBase: new URL(siteUrl),
    title: {
      default: siteTitle,
      template: en ? '%s | Maoyang Taiwan Inc' : '%s | 冒央会社',
    },
    description,
    applicationName: en ? 'Maoyang Taiwan Inc' : '冒央会社',
    keywords: en
      ? ['Maoyang Taiwan Inc', 'liumeiti.vip', 'streaming membership', 'Spotify', 'Netflix', 'Disney+', 'HBO Max', 'VPN', 'ChatGPT', 'Claude', 'AI membership', 'membership sharing']
      : ['冒央会社', 'liumeiti.vip', '流媒体会员', 'Spotify会员', 'Netflix会员', 'Disney+会员', 'HBO Max会员', '机场节点', 'ChatGPT会员', 'Claude会员', 'AI会员', '流媒体合租'],
    authors: [{ name: 'Maoyang Taiwan Inc' }],
    creator: 'Maoyang Taiwan Inc',
    publisher: 'Maoyang Taiwan Inc',
    alternates: {
      canonical: '/',
    },
    icons: METADATA_ICONS,
    manifest: '/manifest.json',
    openGraph: {
      type: 'website',
      locale: en ? 'en_US' : 'zh_CN',
      alternateLocale: en ? 'zh_CN' : 'en_US',
      url: '/',
      siteName: en ? 'Maoyang Taiwan Inc' : '冒央会社',
      title: siteTitle,
      description,
      images: [{ ...SOCIAL_IMAGE_META }],
    },
    twitter: {
      card: 'summary_large_image',
      title: siteTitle,
      description,
      images: [socialImage],
    },
  };
}

const METADATA_ICONS = {
  icon: [
    { url: '/favicon.ico', sizes: 'any' },
    { url: '/favicon.png', sizes: '32x32', type: 'image/png' },
    { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
  ],
  shortcut: [{ url: '/favicon.ico', sizes: 'any' }],
  apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }) {
  const locale = await getServerLocale();
  return (
    <html lang={locale === 'en' ? 'en' : 'zh-CN'}>
      <body>
        <link rel="preload" href="/fonts/inter-400.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/inter-600.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <ReferralTracker />
        <VisitTracker />
        <AnnounceBar />
        <LocaleProvider initialLocale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
