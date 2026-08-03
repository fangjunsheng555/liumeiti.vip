import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const matrix = [
  ["app/api/order/route.js", ["app/checkout/page.jsx"]],
  ["app/api/quote-orders/route.js", ["app/components/ProxyPaymentCheckout.jsx"]],
  ["app/api/quote-orders/[orderId]/route.js", ["app/components/ProxyQuotePayment.jsx"]],
  ["app/api/auth/redeem/route.js", ["app/account/page.jsx", "app/components/RedeemCard.jsx", "app/service-center/page.jsx"]],
  ["app/api/auth/transfer/route.js", ["app/account/page.jsx"]],
  ["app/api/auth/withdraw/route.js", ["app/account/page.jsx"]],
  ["app/api/order-password-update/[orderId]/route.js", ["app/components/SpotifyPasswordUpdate.jsx"]],
  ["app/api/order-password-update/resend/route.js", ["app/service-center/page.jsx"]],
  ["app/api/admin/after-sales/[ticketId]/route.js", ["app/admin/AfterSalesPanel.jsx"]],
  ["app/api/admin/after-sales/notify-by-reference/route.js", ["app/admin/ReferenceNoticeDialog.jsx"]],
  ["app/api/admin/health/incidents/[id]/route.js", ["app/admin/SystemHealthPanel.jsx"]],
  ["app/api/admin/orders/[orderId]/route.js", ["app/admin/page.jsx"]],
  ["app/api/admin/orders/batch/route.js", ["app/admin/page.jsx"]],
  ["app/api/admin/redeem-codes/route.js", ["app/admin/page.jsx"]],
  ["app/api/admin/users/route.js", ["app/admin/page.jsx"]],
  ["app/api/admin/withdrawals/[id]/route.js", ["app/admin/page.jsx"]],
  ["app/api/admin/withdrawals/route.js", ["app/admin/page.jsx"]],
];

async function walk(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(target));
    else if (entry.name === "route.js") results.push(target);
  }
  return results;
}

test("every required-idempotency route is inventoried with header-bearing callers", async () => {
  const actual = [];
  for (const file of await walk(path.join(root, "app", "api"))) {
    const source = await readFile(file, "utf8");
    if (source.includes("requiredIdempotencyKey(request)")) {
      actual.push(path.relative(root, file).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(actual.sort(), matrix.map(([route]) => route).sort());

  for (const [route, callers] of matrix) {
    const routeSource = await readFile(path.join(root, route), "utf8");
    assert.match(routeSource, /requiredIdempotencyKey\(request\)/, route);
    for (const caller of callers) {
      const callerSource = await readFile(path.join(root, caller), "utf8");
      assert.match(callerSource, /["'](?:Idempotency-Key|idempotency-key)["']\s*:/, caller);
    }
  }
});

test("repository-owned external automation does not call protected idempotent mutations", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/maintenance-cron.yml"), "utf8");
  const worker = await readFile(path.join(root, "cloudflare/netflix-email-worker.js"), "utf8");
  const externalSources = `${workflow}\n${worker}`;
  for (const endpoint of [
    "/api/order", "/api/quote-orders", "/api/auth/redeem", "/api/auth/transfer",
    "/api/auth/withdraw", "/api/order-password-update", "/api/admin/orders",
  ]) {
    assert.equal(externalSources.includes(endpoint), false, endpoint);
  }
  assert.match(workflow, /\/api\/cron\/maintenance/);
  assert.match(worker, /\/api\/webhooks\/netflix-email/);
});
