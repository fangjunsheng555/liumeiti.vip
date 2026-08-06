import test from "node:test";
import assert from "node:assert/strict";
import nextConfig from "../next.config.mjs";

test("production CSP does not permit runtime string evaluation", async () => {
  const rules = await nextConfig.headers();
  const catchAll = rules.find((entry) => entry.source === "/:path*");
  const csp = catchAll?.headers?.find((entry) => entry.key === "Content-Security-Policy")?.value || "";
  assert.ok(csp.includes("script-src 'self'"));
  assert.equal(csp.includes("'unsafe-eval'"), false);
});
