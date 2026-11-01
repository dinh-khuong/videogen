"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const ITEMS = [
  { href: "/", label: "Tổng quan", icon: "M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10" },
  { href: "/create", label: "Tạo video", icon: "M12 5v14M5 12h14" },
  { href: "/jobs", label: "Hàng đợi", icon: "M4 6h16M4 12h16M4 18h10" },
  { href: "/videos", label: "Video", icon: "M15 10l5-3v10l-5-3M3 6h12v12H3z" },
  { href: "/assets", label: "Assets", icon: "M4 5h16v14H4zM4 15l4-4 5 5 3-3 4 4M15 9.5a1 1 0 1 0 0-.01" },
  { href: "/crm", label: "Khách hàng", icon: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8" },
];

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks({ mobile }: { mobile?: boolean }) {
  const pathname = usePathname();
  return <NavList pathname={pathname} mobile={mobile} />;
}

/** Bản không đánh dấu mục đang mở, dùng làm fallback khi prerender. */
export function NavList({ pathname, mobile }: { pathname?: string | null; mobile?: boolean }) {
  return (
    <nav className={mobile ? "flex gap-1 overflow-x-auto px-3 pb-2" : "flex flex-col gap-0.5"}>
      {ITEMS.map((item) => {
        const active = isActive(pathname ?? null, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cx(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              mobile && "shrink-0",
              active ? "bg-brand-50 text-brand-700" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
            )}
          >
            <svg viewBox="0 0 24 24" className="size-4.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d={item.icon} />
            </svg>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
