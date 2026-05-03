import './globals.css';

export const metadata = {
  title: '冒央会社-最具性价比的流媒体会员服务',
  description: 'Maoyang Taiwan Inc-Since 2020',
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
