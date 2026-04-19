import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "中華基督教會基慈小學 — 校務會議紀錄查詢",
  description: "校務會議紀錄查詢 Powered by Qwen AI",
  icons: { icon: "/logo.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
