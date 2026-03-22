import './globals.css';

export const metadata = {
  title: '冒央会社 | liumeiti.vip',
  description: 'Maoyang Taiwan Inc-Since 2020',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
