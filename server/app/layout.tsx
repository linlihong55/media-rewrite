import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 内容工作台",
  description: "从趋势发现到发布复盘的个人自媒体内容操作系统",
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
