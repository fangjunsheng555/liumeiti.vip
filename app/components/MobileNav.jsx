"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, ListChecks, ShoppingCart, Headphones, UserRound } from "lucide-react";
import { useCart } from "../lib/store";
import { useLocale } from "./LocaleProvider";

const ITEMS = [
  { href: "/", labelKey: "bnav.home", icon: Home, match: (path) => path === "/" },
  { href: "/shop", labelKey: "bnav.shop", icon: ListChecks, match: (path) => path === "/shop" },
  { href: "/checkout", labelKey: "bnav.cart", icon: ShoppingCart, match: (path) => path === "/checkout", cart: true },
  { href: "/service-center", labelKey: "bnav.center", icon: Headphones, match: (path) => path === "/service-center" },
  { href: "/account", labelKey: "bnav.account", icon: UserRound, match: (path) => path === "/account" },
];

export default function MobileNav() {
  const pathname = usePathname();
  const { cart } = useCart();
  const { t, locale } = useLocale();

  return (
    <nav className="mobile-bottom-nav" aria-label={locale === "en" ? "Main navigation" : "移动端主导航"}>
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.match(pathname);
        return (
          <Link key={item.href} href={item.href} className={`mobile-bottom-nav-item${active ? " active" : ""}`}>
            <span className="mobile-bottom-nav-icon">
              <Icon size={20} strokeWidth={active ? 2.6 : 2.2} />
              {item.cart && cart.length > 0 && <em>{cart.length}</em>}
            </span>
            <span>{t(item.labelKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
