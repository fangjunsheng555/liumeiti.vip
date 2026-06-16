"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALES, detectLocale, getT } from "../lib/i18n";

const LocaleContext = createContext({ locale: DEFAULT_LOCALE, setLocale: () => {}, t: (k) => k });

function readCookieLocale() {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|; )" + LOCALE_COOKIE + "=([^;]+)"));
  const v = m ? decodeURIComponent(m[1]) : null;
  return LOCALES.includes(v) ? v : null;
}

export function LocaleProvider({ children }) {
  // SSR 与首帧用源语言（中文），挂载后按 cookie/浏览器语言切换，避免水合不一致
  const [locale, setLocaleState] = useState(DEFAULT_LOCALE);

  useEffect(() => {
    const initial = readCookieLocale() || detectLocale();
    if (initial !== locale) setLocaleState(initial);
    document.documentElement.lang = initial === "en" ? "en" : "zh-CN";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback((next) => {
    const loc = LOCALES.includes(next) ? next : DEFAULT_LOCALE;
    setLocaleState(loc);
    document.cookie = LOCALE_COOKIE + "=" + loc + "; path=/; max-age=" + 60 * 60 * 24 * 365 + "; samesite=lax";
    if (typeof document !== "undefined") document.documentElement.lang = loc === "en" ? "en" : "zh-CN";
  }, []);

  const t = getT(locale);

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>{children}</LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}
