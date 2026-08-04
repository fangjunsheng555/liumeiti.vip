function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase(); return email.length <= 254 && !/[\x00-\x1f\x7f]/.test(email) ? email : "";
}

// A logged-in checkout may use a different delivery email. User-level
// Netflix controls must follow the account that actually owns the order,
// while the delivery address remains available for support and mail lookup.
export function netflixOrderIdentity(order) {
  const deliveryEmail = normalizeEmail(order?.email);
  const linkedUserEmail = normalizeEmail(order?.userEmail);
  return {
    ownerEmail: linkedUserEmail || deliveryEmail,
    deliveryEmail,
    linkedUserEmail,
  };
}

export function isNetflixOrderOwner(order, email) {
  const candidate = normalizeEmail(email);
  const { ownerEmail } = netflixOrderIdentity(order);
  return Boolean(ownerEmail && candidate && ownerEmail === candidate);
}
