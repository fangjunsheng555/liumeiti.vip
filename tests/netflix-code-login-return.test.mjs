import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const netflixCodePage = await readFile(new URL("../app/netflix-code/page.jsx", import.meta.url), "utf8");
const accountPage = await readFile(new URL("../app/account/page.jsx", import.meta.url), "utf8");

test("Netflix code sign-in keeps a restricted return destination", () => {
  assert.match(netflixCodePage, /\/account\?auth=login&returnTo=%2Fnetflix-code/);
  assert.match(accountPage, /get\("returnTo"\) === "\/netflix-code"/);
  assert.match(accountPage, /window\.location\.replace\(returnTo\)/);
});

test("Google sign-in receives the same Netflix code return destination", () => {
  assert.match(accountPage, /returnTo === "\/netflix-code"/);
  assert.match(accountPage, /params\.set\("returnTo", `\$\{window\.location\.origin\}\$\{returnTo\}`\)/);
  assert.match(accountPage, /handleGoogleOAuthStart\(event, authReturnTo \|\| currentAccountReturnTo\(\)\)/);
});
