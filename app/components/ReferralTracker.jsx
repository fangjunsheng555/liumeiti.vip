"use client";

import { useEffect } from "react";

function normalizeInviteCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
}

export default function ReferralTracker() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search || "");
    const code = normalizeInviteCode(params.get("invite") || params.get("ref"));
    if (!code) return;
    try {
      window.localStorage.setItem("lm_invite", code);
    } catch (e) {}
    document.cookie = `lm_invite=${encodeURIComponent(code)}; Path=/; Max-Age=${60 * 60 * 24 * 180}; SameSite=Lax`;
  }, []);
  return null;
}
