export function normalizeStockValue(raw) {
  if (raw === "" || raw == null || raw === "unlimited") return { ok: true, value: "" };
  if (typeof raw === "boolean" || typeof raw === "object") return { ok: false };
  if (typeof raw === "string" && !raw.trim()) return { ok: false };
  const value = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) return { ok: false };
  return { ok: true, value };
}
