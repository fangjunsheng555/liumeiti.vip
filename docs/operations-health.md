# Production maintenance and health monitoring

## Vercel Hobby schedule

Production intentionally uses three layers so routine recovery work keeps
running without a five-minute Vercel workload:

1. `.github/workflows/maintenance-cron.yml` calls the authenticated
   `/api/cron/maintenance` endpoint at minute 17 of every hour.
2. `vercel.json` retains one daily maintenance invocation at 10:15 UTC
   (18:15 Beijing time) as an independent fallback.
3. The traffic-triggered keeper remains a best-effort compensation path.

The hourly GitHub schedule cuts dispatcher invocations from 288 to 24 per day.
It is the production target while the site remains on Vercel Hobby. Do not
restore a five-minute schedule unless the hosting plan and runtime budget are
reviewed first.

## Environment and missed-run policy

- `MAINTENANCE_CRON_ENABLED=1` enables the authenticated endpoint.
- `OPS_HIGH_FREQUENCY_CRON=1` is a historical variable name retained for
  deployment compatibility. It now means “the external hourly scheduler is
  active”.
- `OPS_MISSED_JOB_ALERTS=1` allows missed-run incidents and Telegram alerts.

With the external scheduler enabled, routine jobs advertise a one-hour target
cadence and are marked possibly missed after 150 minutes. This tolerates normal
GitHub Actions jitter and one lost hourly invocation, while alerting on a
sustained outage. Without it, the Vercel-only baseline is 24 hours with a
30-hour missed threshold. Both the component-health stale badges and the task
incident detector consume this same policy, and the health page receives the
same values from the server, so the three views cannot silently drift apart.

The renewal job keeps its independent 6-hour target and 12-hour alert window
when the hourly dispatcher is active.

## Operational checks

After deployment:

1. Run the workflow once with `workflow_dispatch` and confirm the response has
   `ok: true`.
2. In **后台 → 系统健康 → 任务与队列**, confirm the scheduler note says
   “GitHub 每小时巡检（Hobby 兼容）”.
3. Confirm new job history entries appear and the displayed target/alert values
   are one hour and 2.5 hours for routine jobs.
4. If the workflow is intentionally disabled, set
   `OPS_HIGH_FREQUENCY_CRON=0` before its 150-minute alert window expires.
