"use client";

import { Globe } from "lucide-react";
import { useLocale } from "./LocaleProvider";

export default function LanguageSwitcher({ className = "" }) {
  const { locale, setLocale, t } = useLocale();
  const next = locale === "en" ? "zh" : "en";
  return (
    <button
      type="button"
      className={`lang-switcher ${className}`.trim()}
      aria-label={t("lang.label")}
      title={t("lang.label")}
      onClick={() => setLocale(next)}
    >
      <Globe size={16} strokeWidth={1.6} aria-hidden="true" />
      <span>{locale === "en" ? "中文" : "EN"}</span>
    </button>
  );
}
