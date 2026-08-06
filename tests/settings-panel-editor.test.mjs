import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const panel = await readFile(new URL("../app/admin/SettingsPanel.jsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const adminPage = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");

test("legacy revision zero remains a valid editable settings version", () => {
  assert.match(panel, /Number\.isSafeInteger\(j\.currentVersion\) \? j\.currentVersion : ""/);
  assert.match(panel, /baseVersion:\s*currentVersion/);
  assert.doesNotMatch(panel, /setCurrentVersion\(j\.currentVersion \|\| ""\)/);
});

test("settings edits are guarded, count changes and cannot be overwritten while saving", () => {
  assert.match(panel, /countChangedLeaves\(savedSettings, s\)/);
  assert.match(panel, /window\.addEventListener\("beforeunload", warn\)/);
  assert.match(panel, /window\.confirm\("当前有未保存的修改/);
  assert.match(panel, /onDirtyChange\?\.\(navigationDirty\)/);
  assert.match(panel, /<fieldset className="admin-settings-editor" disabled=\{saving \|\| loading \|\| loadFailed \|\| uploadBusy\}>/);
  assert.match(panel, /disabled=\{saving \|\| loading \|\| loadFailed \|\| uploadBusy \|\| !dirty\}/);
  assert.match(panel, /uploadBusyRef\.current/);
  assert.match(panel, /onProcessingChange\?\.\(true\)/);
  assert.match(adminPage, /<SettingsPanel onDirtyChange=\{setSettingsDirty\}/);
  assert.match(adminPage, /onClick=\{\(\) => \{ if \(confirmEditorLeave\(\)\) doLogout\(\); \}\}/);
});

test("number drafts preserve empty input until explicit validation", () => {
  assert.match(panel, /I\("usdt\.discount", \{ type: "number"/);
  assert.match(panel, /I\("bundle\.tier2Rate", \{ type: "number"/);
  assert.match(panel, /if \(typeof raw !== "string" \|\| !raw\.trim\(\)\) continue/);
  assert.doesNotMatch(panel, /set\("usdt\.discount", Number\(e\.target\.value\)\)/);
});

test("field errors, stale revisions and section resets are understandable", () => {
  assert.match(panel, /setFieldErrors\(j\.fieldErrors/);
  assert.match(panel, /设置已被另一个后台页面修改/);
  assert.match(panel, /恢复本节默认/);
  assert.match(panel, /role=\{msg\.type === "error" \? "alert" : "status"\}/);
  assert.match(css, /\.admin-settings-field input\[aria-invalid="true"\]/);
  assert.match(css, /\.admin-settings-head \{[^}]*position:\s*sticky/);
});

test("visible settings field titles are real accessible labels", () => {
  assert.match(panel, /return <label className=\{`admin-settings-field/);
  assert.match(panel, /<span className="admin-settings-field-label">\{label\}<\/span>\{children\}<\/label>/);
  assert.match(css, /\.admin-settings-field-label \{/);
});
