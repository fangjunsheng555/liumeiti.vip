# Netflix email intake worker

`netflix-email-worker.js` is deployed as a Cloudflare Email Worker for the
`codes.liumeiti.vip` subdomain. It forwards the raw MIME message to the site's
signed webhook; it does not parse, log, or expose a Netflix code inside
Cloudflare.

Required Worker secret:

- `NETFLIX_EMAIL_INGEST_SECRET`: the same independent 32+ character value used
  by the Vercel project.

Optional Worker variable:

- `INGEST_ENDPOINT`: defaults to
  `https://www.liumeiti.vip/api/webhooks/netflix-email`.

The exact Email Routing address `netflix@codes.liumeiti.vip` sends mail to this
Worker. Forward each Netflix account mailbox to that address; the raw original
recipient/sender headers are preserved for order matching. A catch-all is not
required and should remain disabled to reduce unrelated inbound mail.

Do not replace the apex-domain MX records used by the site's normal mailbox.
