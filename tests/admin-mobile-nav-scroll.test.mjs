import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminPageSource = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("mobile admin navigation locks and restores the background scroll position", () => {
  assert.match(adminPageSource, /body\.style\.position = "fixed"/);
  assert.match(adminPageSource, /body\.style\.top = `-\$\{scrollY\}px`/);
  assert.match(adminPageSource, /window\.scrollTo\(\{ top: scrollY, left: 0, behavior: "auto" \}\)/);
});

test("mobile admin sidebar owns vertical touch scrolling without chaining to the page", () => {
  assert.match(globalStyles, /\.admin-sidebar\s*\{[\s\S]*?height: 100dvh;[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior-y: contain;[\s\S]*?touch-action: pan-y;/);
  assert.match(globalStyles, /\.admin-shell\.nav-open \.admin-nav-scrim\s*\{[\s\S]*?touch-action: none;/);
  assert.match(adminPageSource, /mobileNavQuery\.addEventListener\("change", onBreakpointChange\)/);
});
