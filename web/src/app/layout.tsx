import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { NavLinks, NavList } from "@/components/nav";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin", "vietnamese"] });

export const metadata: Metadata = {
  title: { default: "VideoGen Studio", template: "%s · VideoGen Studio" },
  description: "Tạo video hướng dẫn bằng AI, quản lý thư viện ảnh, video và khách hàng.",
};

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 px-3 py-1">
      <span className="grid size-8 place-items-center rounded-lg bg-brand-500 text-white">
        <svg viewBox="0 0 24 24" className="size-4" fill="currentColor">
          <path d="M8 5.5v13l10.5-6.5L8 5.5Z" />
        </svg>
      </span>
      <span className="font-semibold tracking-tight text-zinc-900">VideoGen Studio</span>
    </Link>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full font-sans">
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-6 border-r border-zinc-200 bg-white px-3 py-5 md:flex">
            <Brand />
            <Suspense fallback={<NavList />}>
              <NavLinks />
            </Suspense>
            <p className="mt-auto px-3 text-xs leading-relaxed text-zinc-400">
              Dữ liệu lưu trên máy này (SQLite + thư mục data/). Video được tạo bởi engine Python chạy riêng.
            </p>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/95 pt-3 backdrop-blur md:hidden">
              <div className="mb-2">
                <Brand />
              </div>
              <Suspense fallback={<NavList mobile />}>
                <NavLinks mobile />
              </Suspense>
            </header>
            <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
