function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function authenticatedUserMatches(user, expectedEmail, expectedLifecycle = "") {
  const expected = normalizedEmail(expectedEmail);
  const actual = normalizedEmail(user?.email);
  const lifecycle = String(user?.accountLifecycleId || "").trim();
  const expectedLifecycleId = String(expectedLifecycle || "").trim();
  return Boolean(
    user?.ok === true
    && expected
    && actual === expected
    && /^[a-f0-9]{32}$/i.test(lifecycle)
    && /^[a-f0-9]{32}$/i.test(expectedLifecycleId)
    && lifecycle.toLowerCase() === expectedLifecycleId.toLowerCase()
  );
}

export function isSuccessfulAuthResponse(response, data, mode) {
  return Boolean(
    response?.ok === true
    && data?.ok === true
    && (mode !== "forgot" || data?.accepted === true)
  );
}

export function shouldRecoverAuthMutationResponse(mode, status, errorCode) {
  if (!["register", "reset"].includes(mode)) return false;
  const responseStatus = Number(status || 0);
  const code = String(errorCode || "").trim().toLowerCase();
  if (mode === "register" && code === "captcha_store_unavailable") return false;
  if ([403, 409].includes(responseStatus)) {
    return !(mode === "register" && code === "email_taken");
  }
  if (responseStatus >= 500 && responseStatus <= 599) return true;
  return false;
}

export function safeLoginAfterUncertainAuth(mode, form = {}) {
  if (!["register", "reset"].includes(mode)) return null;
  return safeLoginAfterConfirmedAuth(mode, form);
}

export function safeLoginAfterConfirmedAuth(mode, form = {}) {
  return {
    mode: "login",
    form: {
      ...form,
      password: mode === "reset" ? String(form.newPassword || "") : String(form.password || ""),
    },
  };
}

export function shouldReauthenticateAfterAuthVerification(result) {
  return Boolean(
    result?.guest === true
    || result?.identityMismatch === true
    || [401, 403, 409].includes(Number(result?.status || 0))
  );
}
