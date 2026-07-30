import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Panda AI锐评局",
  description: "金融 A2A Agent 研究严谨性、数据纪律与同题基准对测平台",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
