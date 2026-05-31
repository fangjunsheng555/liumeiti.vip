"use client";

import { useState } from "react";
import { Headphones, X } from "lucide-react";
import { QQBrandIcon, TelegramBrandIcon, WhatsAppBrandIcon } from "./BrandIcons";

export default function FloatingSupport() {
  const [open, setOpen] = useState(false);

  return (
    <div className="floating-wrap">
      {open && (
        <div className="floating-panel floating-panel-icons">
          <div className="floating-icons-row">
            <a
              href="mqq://im/chat?chat_type=wpa&uin=2802632995&version=1&src_type=web"
              className="floating-icon-btn qq"
              aria-label="QQ 客服"
            >
              <QQBrandIcon />
            </a>
            <a
              href="https://wa.me/message/MRLWFP22GKEAE1"
              target="_blank"
              rel="noopener noreferrer"
              className="floating-icon-btn whatsapp"
              aria-label="WhatsApp 客服"
            >
              <WhatsAppBrandIcon />
            </a>
            <a
              href="https://t.me/MaoyangSupport"
              target="_blank"
              rel="noopener noreferrer"
              className="floating-icon-btn telegram"
              aria-label="Telegram 客服"
            >
              <TelegramBrandIcon />
            </a>
          </div>
          <div className="floating-hours-line">在线时间:9:00 - 23:00</div>
        </div>
      )}
      <button
        type="button"
        className={`floating-button${open ? "" : " has-pulse"}`}
        onClick={() => setOpen((value) => !value)}
        aria-label="打开客服菜单"
      >
        {open ? <X size={22} /> : <Headphones size={22} />}
        {!open && <span className="floating-online-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
