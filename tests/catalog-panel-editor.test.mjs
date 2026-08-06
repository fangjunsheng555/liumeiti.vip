import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/admin/CatalogPanel.jsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const adminPage = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");

function functionDeclaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (["'", '"', "`"].includes(char)) { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

const helpers = vm.runInNewContext(`
  ${functionDeclaration("isSafeImage")}
  ${functionDeclaration("localValidation")}
  ({ isSafeImage, localValidation });
`, {
  URL,
  getCatalogDisplayPrice(product) {
    const prices = product.plans.filter((plan) => plan.active !== false && plan.amount > 0).map((plan) => plan.amount);
    return prices.length ? `¥${Math.min(...prices)}` : product.priceText;
  },
});

function product({ quoteOnly = false } = {}) {
  return {
    key: quoteOnly ? "proxy-pay" : "spotify",
    title: "Spotify",
    image: "/products/spotify.jpg",
    active: true,
    quoteOnly,
    defaultPlan: quoteOnly ? "quote" : "member",
    priceText: quoteOnly ? "3折起" : "¥128",
    plans: quoteOnly
      ? [{ id: "quote", label: "人工报价", amount: 0, active: true }]
      : [{ id: "member", label: "家庭成员", amount: 128, active: true }],
  };
}

test("price drafts preserve an empty edit and reject free or malformed normal-product prices", () => {
  for (const raw of ["", "0", "-1", "12.345", "1000000.01"]) {
    const item = product();
    const result = helpers.localValidation([item], { "spotify:member": raw });
    assert.equal(result.ok, false, `price ${raw || "<empty>"} must be rejected`);
    assert.match(result.errors["spotify.member.amount"], /价格须大于 0/);
  }
  const valid = helpers.localValidation([product()], { "spotify:member": "12.50" });
  assert.equal(valid.ok, true);
  assert.equal(valid.catalog[0].plans[0].amount, 12.5);
  const quote = helpers.localValidation([product({ quoteOnly: true })], { "proxy-pay:quote": "" });
  assert.equal(quote.ok, true);
  assert.equal(quote.catalog[0].plans[0].amount, 0);
  assert.doesNotMatch(source, /patchPlan\([^\n]+"amount",\s*Number\(/);
});

test("image validation matches the server contract and the editor renders a live preview", () => {
  for (const value of ["/products/custom.jpg", "https://cdn.example.com/product.webp?x=1"]) assert.equal(helpers.isSafeImage(value), true);
  for (const value of ["", "//evil.example/a.jpg", "http://evil.example/a.jpg", "javascript:alert(1)", "https://u:p@example.com/a.jpg"]) assert.equal(helpers.isSafeImage(value), false);
  assert.match(source, /value=\{product\.image \|\| ""\}/);
  assert.match(source, /alt=\{`\$\{product\.title\} 图片预览`\}/);
  assert.match(source, /product\.detailTitle/);
  assert.match(source, /product\.detailBody/);
  assert.match(source, /product\.cycle/);
});

test("compact cards are searchable, collapsible and summarize state, price and plan count", () => {
  assert.match(source, /const \[search, setSearch\] = useState\(""\)/);
  assert.match(source, /const \[openProducts, setOpenProducts\]/);
  assert.match(source, /aria-expanded=\{expanded\}/);
  assert.match(source, /上架中/);
  assert.match(source, /Math\.min\(\.\.\.numericPrices\)/);
  assert.match(source, /\{product\.plans\?\.length \|\| 0\} 个规格/);
  assert.match(source, /<select value=\{product\.defaultPlan \|\| ""\}/);
  assert.match(source, /\{activePlans\.map\(/);
});

test("dirty edits are counted, guarded from loss and locked while a save is in flight", () => {
  assert.match(source, /const dirtyCount = useMemo\(/);
  assert.match(source, /\{dirty \? `\$\{dirtyCount\} 项未保存` : "所有修改已保存"\}/);
  assert.match(source, /window\.addEventListener\("beforeunload", beforeUnload\)/);
  assert.match(source, /当前有未保存修改，确定重载并放弃这些修改吗/);
  assert.match(source, /<fieldset[^>]+disabled=\{controlsBusy\}/);
  assert.match(source, /disabled=\{controlsBusy \|\| !dirty\}/);
  assert.match(source, /if \(controlsBusy\) return;/);
  assert.match(source, /onDirtyChange\?\.\(dirty\)/);
  assert.match(adminPage, /const confirmEditorLeave = useCallback/);
  assert.match(adminPage, /当前页面有未保存的修改/);
  assert.match(adminPage, /if \(!setTab\(it\.key\)\) return/);
  assert.match(adminPage, /<CatalogPanel onDirtyChange=\{setCatalogDirty\}/);
});

test("malformed successful catalog responses stay in a retryable failure state", () => {
  assert.match(source, /!Array\.isArray\(data\.catalog\) \|\| data\.catalog\.length === 0/);
  assert.match(source, /setLoadFailed\(true\)/);
  assert.match(source, /saving \|\| loading \|\| loadFailed \|\| historyLoading/);
  assert.match(source, /Array\.isArray\(data\.versions\) \? data\.versions : \[\]/);
});

test("version conflicts and committed-catalog stock failures retain a safe retry state", () => {
  assert.match(source, /data\?\.catalogCommitted === true && Array\.isArray\(data\.catalog\)/);
  assert.match(source, /const failedKeys = new Set/);
  assert.match(source, /Object\.entries\(submittedStock\)\.filter\(\(\[key\]\) => failedKeys\.has\(key\)\)/);
  assert.match(source, /setCatalog\(data\.catalog\)/);
  assert.match(source, /setCurrentVersion\(data\.currentVersion \|\| currentVersion\)/);
  assert.match(source, /目录已发布但部分库存未更新/);
  assert.match(css, /\.admin-settings-alert\.warning/);
  assert.match(source, /response\.status === 409 \|\| data\?\.error === "version_conflict"/);
  assert.match(source, /该目录已被其他后台页面修改/);
});

test("mobile catalog layout exposes labels and cannot require horizontal scrolling", () => {
  assert.match(source, /<span>规格名称<\/span>/);
  assert.match(source, /<span>实收价<\/span>/);
  assert.match(source, /<span>库存<\/span>/);
  assert.match(css, /\.admin-catalog-plan-row \{[\s\S]*?min-width:\s*0/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.admin-catalog-plan-row \{ grid-template-columns: 1fr;/);
  assert.match(css, /\.admin-catalog-search input \{[^}]*min-width:\s*0/);
  assert.doesNotMatch(css, /\.admin-catalog[^\n{]*\{[^}]*min-width:\s*[1-9]\d{3}px/);
});
