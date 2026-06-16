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

export function LocaleProvider({ children, initialLocale }) {
  // 服务端已按 cookie / Accept-Language 决定语种并作为首帧初值，水合一致、无中文闪烁。
  const [locale, setLocaleState] = useState(
    LOCALES.includes(initialLocale) ? initialLocale : DEFAULT_LOCALE,
  );

  useEffect(() => {
    const cookie = readCookieLocale();
    if (cookie) {
      // 已有 cookie：与服务端一致，必要时校正
      if (cookie !== locale) setLocaleState(cookie);
      document.documentElement.lang = cookie === "en" ? "en" : "zh-CN";
      return;
    }
    // 首次访问无 cookie：服务端已用 Accept-Language 决定，这里用浏览器语言二次确认并落 cookie
    const detected = detectLocale();
    const next = LOCALES.includes(detected) ? detected : locale;
    if (next !== locale) setLocaleState(next);
    document.cookie = LOCALE_COOKIE + "=" + next + "; path=/; max-age=" + 60 * 60 * 24 * 365 + "; samesite=lax";
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
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
