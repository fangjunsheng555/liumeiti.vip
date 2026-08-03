import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/netflix-code/page.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/netflix-code/netflix-code.module.css", import.meta.url), "utf8");

test("Netflix code result is selectable, copyable and announces both copy outcomes", () => {
  assert.match(page, /<output tabIndex=\{0\} aria-label=\{L\(`Netflix 登录码 \$\{result\.code\}`/);
  assert.match(page, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(page, /复制失败，请选中上方登录码手动复制/);
  assert.match(page, /className=\{styles\.copyFeedback\} data-state=\{codeCopyState\} role="status" aria-live="polite"/);
  assert.match(styles, /\.codeSurface output\s*\{[^}]*user-select:\s*all/s);
});

test("code, travel and household results share the same compact action hierarchy", () => {
  assert.equal((page.match(/className=\{`\$\{styles\.resultPanel\}/g) || []).length, 3);
  assert.equal((page.match(/onClick=\{retrieveAnotherEmail\}/g) || []).length, 3);
  assert.match(page, /className=\{styles\.copyCode\} onClick=\{copyResultCode\}/);
  assert.equal((page.match(/className=\{styles\.netflixAction\}/g) || []).length, 2);
  assert.match(styles, /\.resultPanel\s*\{[^}]*width:\s*min\(100%, 520px\)/s);
  assert.match(styles, /\.resultActions\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /@media \(max-width: 460px\)\s*\{[\s\S]*?\.resultActions\s*\{\s*grid-template-columns:\s*1fr/);
});

test("Netflix result and transient states preserve keyboard and screen-reader context", () => {
  assert.equal((page.match(/ref=\{resultPanelRef\} tabIndex=\{-1\}/g) || []).length, 3);
  assert.match(page, /resultPanelRef\.current\?\.focus\(\)/);
  assert.match(page, /retrieveButtonRef\.current\?\.focus\(\)/);
  assert.match(page, /role=\{status\.type === "error" \? "alert" : "status"\}/);
  assert.match(styles, /\.page :is\(a, button, input\):focus-visible/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("result copy explains validity and limits its security claim to official Netflix pages", () => {
  assert.match(page, /Netflix 登录码通常在 15 分钟内有效/);
  assert.match(page, /仅在 Netflix 官方页面输入，请勿分享给他人/);
  assert.match(page, /链接仅用于本次登录，请勿转发/);
  assert.match(page, /链接约 15 分钟内有效，请勿转发/);
});
