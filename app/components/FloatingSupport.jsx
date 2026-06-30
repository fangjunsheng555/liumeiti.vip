"use client";

import { useState } from "react";
import { Headphones, X } from "lucide-react";
import { QQBrandIcon, TelegramBrandIcon, WhatsAppBrandIcon } from "./BrandIcons";
import { useLocale } from "./LocaleProvider";
import { useSiteSettings } from "../lib/store";

export default function FloatingSupport() {
  const [open, setOpen] = useState(false);
  const { locale } = useLocale();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const s = useSiteSettings().support; // 客服联系方式以后台设置为准

  return (
    <div className="floating-wrap">
      {open && (
        <div className="floating-panel floating-panel-icons">
          <div className="floating-icons-row">
            <a
              href={s.qq.href}
              className="floating-icon-btn qq"
              aria-label={L("QQ 客服", "QQ support")}
            >
              <QQBrandIcon />
            </a>
            <a
              href={s.whatsapp.href}
              target="_blank"
              rel="noopener noreferrer"
              className="floating-icon-btn whatsapp"
              aria-label={L("WhatsApp 客服", "WhatsApp support")}
            >
              <WhatsAppBrandIcon />
            </a>
            <a
              href={s.telegram.href}
              target="_blank"
              rel="noopener noreferrer"
              className="floating-icon-btn telegram"
              aria-label={L("Telegram 客服", "Telegram support")}
            >
              <TelegramBrandIcon />
            </a>
          </div>
          <div className="floating-hours-line">{L("在线时间:9:00 - 23:00", "Online: 9:00 - 23:00")}</div>
        </div>
      )}
      <button
        type="button"
        className={`floating-button${open ? "" : " has-pulse"}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? L("关闭客服菜单", "Close support menu") : L("打开客服菜单", "Open support menu")}
      >
        {open ? <X size={22} /> : <Headphones size={22} />}
        {!open && <span className="floating-online-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
