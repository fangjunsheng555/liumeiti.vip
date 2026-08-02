import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("logout UIs do not pretend a failed durable revocation succeeded", async () => {
  const [account, admin, checkout] = await Promise.all([
    readFile(new URL("../app/account/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/checkout/page.jsx", import.meta.url), "utf8"),
  ]);
  const accountLogout = account.slice(account.indexOf("async function logout()"), account.indexOf("async function doAuth", account.indexOf("async function logout()")));
  const adminLogout = admin.slice(admin.indexOf("async function doLogout()"), admin.indexOf("async function openOrder", admin.indexOf("async function doLogout()")));
  assert.match(accountLogout, /if \(!response\.ok \|\| !data\?\.ok/);
  assert.match(accountLogout, /setLogoutError/);
  assert.ok(accountLogout.indexOf("if (!response.ok") < accountLogout.indexOf('window.location.href = "/"'));
  assert.match(adminLogout, /const alreadyInvalid = response\.status === 401/);
  assert.match(adminLogout, /setLogoutError/);
  assert.ok(adminLogout.indexOf("if ((!response.ok") < adminLogout.indexOf("setAuthed(false)"));

  const guestRecovery = checkout.slice(
    checkout.indexOf("async function signOutAndRecoverGuestOrder()"),
    checkout.indexOf("function clearPendingJournal", checkout.indexOf("async function signOutAndRecoverGuestOrder()")),
  );
  assert.match(guestRecovery, /if \(!response\.ok \|\| !data\?\.ok \|\| typeof data\.revoked !== "boolean"\)/);
  assert.ok(guestRecovery.indexOf("if (!response.ok") < guestRecovery.indexOf("setAuthedUser(null)"));
  assert.ok(guestRecovery.indexOf("if (!response.ok") < guestRecovery.indexOf("await replayPendingOrder"));
});
