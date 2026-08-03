import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const accountUrl = new URL("../app/account/page.jsx", import.meta.url);
const stylesUrl = new URL("../app/globals.css", import.meta.url);

test("account notification and email settings live in one compact accessible dialog", async () => {
  const source = await readFile(accountUrl, "utf8");
  const triggerIndex = source.indexOf('className="account-preferences-trigger"');
  const modalIndex = source.indexOf("{preferencesModal && (");
  const pageFlowEnd = source.lastIndexOf("</main>", modalIndex);

  assert.ok(triggerIndex > 0, "the profile card exposes a compact preferences trigger");
  assert.ok(pageFlowEnd > 0 && modalIndex > pageFlowEnd, "settings are outside the account page flow and no longer lengthen it");
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /aria-expanded=\{preferencesModal\}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby="account-preferences-title"/);
  assert.match(source, /aria-describedby="account-preferences-description"/);
  assert.equal((source.match(/<PushNotificationSettings locale=\{locale\} \/>/g) || []).length, 1);
  assert.equal((source.match(/<EmailPreferenceSettings locale=\{locale\} \/>/g) || []).length, 1);
});

test("preferences dialog traps focus, closes with Escape, restores focus and locks page scroll", async () => {
  const source = await readFile(accountUrl, "utf8");
  assert.match(source, /event\.key === "Escape"[\s\S]{0,120}setPreferencesModal\(false\)/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /dialog\.querySelectorAll\(focusableSelector\)/);
  assert.match(source, /focusIsOutsideCycle[\s\S]{0,240}\(event\.shiftKey \? last : first\)\.focus\(\)/);
  assert.match(source, /document\.body\.style\.overflow = "hidden"/);
  assert.match(source, /document\.body\.style\.overflow = previousOverflow/);
  assert.match(source, /preferencesTitleRef\.current\?\.focus\(\)/);
  assert.match(source, /preferencesTriggerRef\.current\?\.focus\(\)/);
  assert.match(source, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
});

test("preferences dialog has bounded responsive scrolling instead of extending the page", async () => {
  const styles = await readFile(stylesUrl, "utf8");
  assert.match(styles, /\.account-preferences-modal\s*\{[\s\S]*?max-height:[^;]+;[\s\S]*?overflow:\s*hidden;/);
  assert.match(styles, /\.account-preferences-body\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.account-preferences-modal\s*\{[\s\S]*?100dvh[\s\S]*?border-radius:\s*18px 18px 0 0;/);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*?\.account-preferences-trigger\s*\{[\s\S]*?width:\s*36px;/);
  assert.match(styles, /\.account-preferences-mask\s*\{[\s\S]*?z-index:\s*230;[\s\S]*?place-items:\s*center;/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.account-preferences-mask\s*\{[\s\S]*?place-items:\s*end center;/);
});
