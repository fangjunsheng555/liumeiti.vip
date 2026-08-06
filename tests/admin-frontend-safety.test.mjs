import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);

test("admin PDF exports escape editable footer text and sever popup opener before writing", async () => {
  const source = await readFile(new URL("app/admin/page.jsx", ROOT), "utf8");

  assert.equal(
    (source.match(/\$\{escapeHtml\(getSiteSettings\(\)\.footer\.brand\)\}/g) || []).length,
    2,
    "both PDF implementations must escape the editable brand",
  );
  assert.equal(
    (source.match(/\$\{escapeHtml\(getSiteSettings\(\)\.footer\.copyright\)\}/g) || []).length,
    2,
    "both PDF implementations must escape the editable copyright",
  );
  assert.doesNotMatch(source, /\$\{getSiteSettings\(\)\.footer\.(?:brand|copyright)\}/);
  assert.equal(
    (source.match(/win\.opener = null;\s*win\.document\.open\(\);/g) || []).length,
    2,
    "the popup must lose access to its opener before either document is written",
  );
});

test("admin batch-mode updater is pure and performs sibling state changes outside it", async () => {
  const source = await readFile(new URL("app/admin/page.jsx", ROOT), "utf8");
  const start = source.indexOf("function toggleBatchMode()");
  const end = source.indexOf("function toggleSelect", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const toggle = source.slice(start, end);

  assert.match(toggle, /const next = !batchMode;/);
  assert.match(toggle, /setBatchMode\(next\);/);
  assert.match(toggle, /if \(!next\) setSelectedIds\(new Set\(\)\);/);
  assert.doesNotMatch(toggle, /setBatchMode\(\s*\([^)]*\)\s*=>/);
});
