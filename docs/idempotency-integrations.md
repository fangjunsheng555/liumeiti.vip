# Idempotency integration audit

## Required mutation callers

| Mutation | Repository caller(s) |
| --- | --- |
| `POST /api/order` | `app/checkout/page.jsx` |
| `POST /api/quote-orders` | `app/components/ProxyPaymentCheckout.jsx` |
| `POST /api/quote-orders/:orderId` | `app/components/ProxyQuotePayment.jsx` |
| `POST /api/auth/redeem` | `app/account/page.jsx`, `app/components/RedeemCard.jsx`, `app/service-center/page.jsx` |
| `POST /api/auth/transfer` | `app/account/page.jsx` |
| `POST /api/auth/withdraw` | `app/account/page.jsx` |
| `PATCH /api/order-password-update/:orderId` | `app/components/SpotifyPasswordUpdate.jsx` |
| `POST /api/order-password-update/resend` | `app/service-center/page.jsx` |
| `PATCH /api/admin/after-sales/:ticketId` | `app/admin/AfterSalesPanel.jsx` |
| `POST /api/admin/after-sales/notify-by-reference` | `app/admin/ReferenceNoticeDialog.jsx` |
| `PATCH /api/admin/health/incidents/:id` | `app/admin/SystemHealthPanel.jsx` |
| `PATCH, DELETE /api/admin/orders/:orderId` | `app/admin/page.jsx` |
| `POST /api/admin/orders/batch` | `app/admin/page.jsx` |
| `POST /api/admin/redeem-codes` | `app/admin/page.jsx` |
| `POST /api/admin/users` | `app/admin/page.jsx` |
| `PATCH /api/admin/withdrawals/:id` | `app/admin/page.jsx` |
| `DELETE /api/admin/withdrawals` | `app/admin/page.jsx` |

Every listed caller persists or retains a request-specific key and sends it in
`Idempotency-Key`. `tests/idempotency-route-coverage.test.mjs` fails if a route
using `requiredIdempotencyKey(request)` is missing from this inventory or if a
listed caller stops carrying the header.

## External integration evidence and compatibility policy

Repository history, the current Cloudflare worker, `vercel.json`, README files,
and GitHub workflows contain no machine caller for the mutations above. The
only repository-owned external jobs call `/api/cron/maintenance`,
`/api/cron/marketing-campaign`, or `/api/webhooks/netflix-email`; none uses a
route in this inventory. The affected account/admin routes also require a user,
staff, or signed-link identity, which matches their browser callers.

This repository audit cannot prove that an unpublished private script does not
exist. Such a script must be updated to send a stable key for one logical
operation and reuse the same key on transport retries. The public routes do not
derive a key from the request body: doing so would collapse legitimate repeated
orders/transfers with identical content and weaken replay protection.

If a legacy machine integration is later identified, use a separate authenticated
adapter or an explicit allowlist plus a stable upstream event ID. Do not enable a
global missing-header fallback on customer or money routes.
