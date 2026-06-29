"use client";

import { useEffect } from "react";

function normalizeInviteCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
}

function inviteCookieAttributes(includeDomain = false) {
  const attrs = ["Path=/", `Max-Age=${60 * 60 * 24 * 180}`, "SameSite=Lax"];
  if (includeDomain) attrs.splice(1, 0, "Domain=.liumeiti.vip");
  if (typeof window !== "undefined" && window.location.protocol === "https:") attrs.push("Secure");
  return attrs.join("; ");
}

function canUseSharedInviteCookie() {
  if (typeof window === "undefined") return false;
  const host = String(window.location.hostname || "").toLowerCase();
  return host === "liumeiti.vip" || host.endsWith(".liumeiti.vip");
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
    const encoded = encodeURIComponent(code);
    document.cookie = `lm_invite=${encoded}; ${inviteCookieAttributes(false)}`;
    if (canUseSharedInviteCookie()) {
      document.cookie = `lm_invite=${encoded}; ${inviteCookieAttributes(true)}`;
    }
  }, []);
  return null;
}
