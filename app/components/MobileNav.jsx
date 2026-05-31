"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, ListChecks, ShoppingCart, Headphones, UserRound } from "lucide-react";
import { useCart } from "../lib/store";

const ITEMS = [
  { href: "/", label: "首页", icon: Home, match: (path) => path === "/" },
  { href: "/shop", label: "选购", icon: ListChecks, match: (path) => path === "/shop" },
  { href: "/checkout", label: "购物车", icon: ShoppingCart, match: (path) => path === "/checkout", cart: true },
  { href: "/service-center", label: "服务中心", icon: Headphones, match: (path) => path === "/service-center" },
  { href: "/account", label: "我的", icon: UserRound, match: (path) => path === "/account" },
];

export default function MobileNav() {
  const pathname = usePathname();
  const { cart } = useCart();

  return (
    <nav className="mobile-bottom-nav" aria-label="移动端主导航">
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.match(pathname);
        return (
          <Link key={item.href} href={item.href} className={`mobile-bottom-nav-item${active ? " active" : ""}`}>
            <span className="mobile-bottom-nav-icon">
              <Icon size={20} strokeWidth={active ? 2.6 : 2.2} />
              {item.cart && cart.length > 0 && <em>{cart.length}</em>}
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
