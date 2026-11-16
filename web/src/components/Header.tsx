"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { USE_MOCKS } from "@/lib/api";
import Logo from "./Logo";

export default function Header() {
  const path = usePathname();
  const inApp = path.startsWith("/app") || path.startsWith("/d/");
  const items: [string, string, boolean][] = [
    ["/", "How it works", path === "/"],
    ["/app", "Design molecules", inApp],
    ["/validation", "Does it work?", path === "/validation"],
  ];
  return (
    <header className="sticky top-0 z-30 bg-background/85 backdrop-blur-md">
      <div className="mx-auto grid h-16 max-w-[1280px] grid-cols-[1fr_auto] items-center gap-4 px-4 sm:px-8 md:grid-cols-[1fr_auto_1fr]">
        <Link href="/" className="flex items-center gap-2.5 justify-self-start text-[17px] font-extrabold tracking-[-0.02em]">
          <Logo />
          Scaffold
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1 rounded-full bg-surface p-1 shadow-soft max-md:hidden">
          {items.map(([href, label, active]) => (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                active ? "bg-foreground text-surface" : "text-muted hover:bg-soft-2 hover:text-foreground"
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center justify-end gap-2">
          {USE_MOCKS && (
            <span
              title="No backend configured. Showing a saved snapshot of real results for the three example diseases."
              className="rounded-full bg-[#FBEFD9] px-3 py-1 text-xs font-semibold text-[#6B4A06]"
            >
              Offline snapshot
            </span>
          )}
          <Link
            href="/app"
            className="inline-flex h-10 items-center rounded-full bg-foreground px-4 text-sm font-semibold text-surface transition-colors hover:bg-accent-ink md:hidden"
          >
            Design
          </Link>
        </div>
      </div>
      {/* phones: the nav as a scrollable strip under the bar */}
      <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden">
        {items.map(([href, label, active]) => (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${active ? "bg-foreground text-surface" : "text-muted"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
