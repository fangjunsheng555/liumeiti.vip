import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminPageSource = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("mobile admin navigation locks and restores the background scroll position", () => {
  assert.match(adminPageSource, /body\.style\.position = "fixed"/);
  assert.match(adminPageSource, /body\.style\.top = `-\$\{scrollY\}px`/);
  assert.match(adminPageSource, /window\.scrollTo\(\{ top: scrollY, left: 0, behavior: "auto" \}\)/);
  assert.match(globalStyles, /html:has\(\.admin-page\),\s*body:has\(\.admin-page\)\s*\{[\s\S]*?overflow-x: clip;[\s\S]*?overflow-y: visible;/);
});

test("mobile admin sidebar owns vertical touch scrolling without chaining to the page", () => {
  assert.match(globalStyles, /\.admin-sidebar\s*\{[\s\S]*?height: 100dvh;[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior-y: contain;[\s\S]*?touch-action: pan-y;/);
  assert.match(globalStyles, /\.admin-shell\.nav-open \.admin-nav-scrim\s*\{[\s\S]*?touch-action: none;/);
  assert.match(adminPageSource, /mobileNavQuery\.addEventListener\("change", onBreakpointChange\)/);
});

test("narrow admin header keeps the context tag and logout action horizontal", () => {
  assert.match(globalStyles, /@media \(max-width: 480px\)\s*\{[\s\S]*?\.admin-header\s*\{[\s\S]*?flex-wrap: nowrap;[\s\S]*?padding-inline: 12px;/);
  assert.match(globalStyles, /\.admin-logo\s*\{\s*max-width: 92px;\s*\}/);
  assert.match(adminPageSource, /<Link href="\/" className="admin-logo-link" aria-label=[^>]+onClick=\{\(event\) => \{ if \(!confirmEditorLeave\(\)\) event\.preventDefault\(\); \}\}>/);
  assert.match(globalStyles, /@media \(max-width: 360px\)\s*\{\s*\.admin-logo-link\s*\{\s*display: none;\s*\}/);
  assert.match(globalStyles, /\.admin-tag,\s*\.admin-logout\s*\{[\s\S]*?flex-shrink: 0;[\s\S]*?white-space: nowrap;/);
  assert.match(globalStyles, /\.admin-logout\s*\{\s*margin-left: auto;\s*\}/);
  assert.match(globalStyles, /@media \(max-width: 900px\)\s*\{\s*\.aiq-sticky\s*\{\s*top: 60px;\s*\}/);
});
