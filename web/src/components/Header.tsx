"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { USE_MOCKS } from "@/lib/api";
import Logo from "./Logo";

export default function Header() {
  const path = usePathname();
  const inApp = path.startsWith("/app") || path.startsWith("/d/");
  const link = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      className={`rounded-full px-4 py-2.5 text-sm font-semibold transition-colors ${
        active ? "bg-foreground text-background" : "text-foreground hover:bg-soft"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <header className="relative z-30">
      <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-3 px-4 py-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5 text-[17px] font-extrabold tracking-tight">
          <Logo />
          RepurposeKG
        </Link>
        {USE_MOCKS && (
          <span
            title="No backend configured. Showing a saved snapshot of real results for the three example diseases."
            className="rounded-full bg-[#FBEFD9] px-3 py-1 text-xs font-semibold text-[#6B4A06]"
          >
            Offline snapshot
          </span>
        )}
        <nav className="ml-auto flex items-center gap-1">
          {link("/", "Product", path === "/")}
          {link("/app", "Try it", inApp)}
          {link("/validation", "Validation", path === "/validation")}
        </nav>
      </div>
    </header>
  );
}
