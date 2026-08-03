import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Hobby production dispatcher runs hourly with a daily Vercel fallback", async () => {
  const [workflow, vercelConfig] = await Promise.all([
    readFile(new URL(".github/workflows/maintenance-cron.yml", root), "utf8"),
    readFile(new URL("vercel.json", root), "utf8"),
  ]);

  assert.match(workflow, /cron:\s*["']17 \* \* \* \*["']/);
  assert.doesNotMatch(workflow, /cron:\s*["']\*\/5 \* \* \* \*['"]/);

  const config = JSON.parse(vercelConfig);
  const maintenance = config.crons.find((entry) => entry.path === "/api/cron/maintenance");
  assert.deepEqual(maintenance, { path: "/api/cron/maintenance", schedule: "15 10 * * *" });
});
test("external scheduler policy uses one-hour cadence and a 150-minute alarm window", () => {
  const runnerUrl = new URL("app/api/_job-runner.js", root).href;
  const script = `
    process.env.OPS_HIGH_FREQUENCY_CRON = "1";
    const module = await import(${JSON.stringify(runnerUrl)});
    process.stdout.write(JSON.stringify({
      scheduler: module.MAINTENANCE_SCHEDULER,
      routine: module.JOB_POLICIES.order_transition,
      renewal: module.JOB_POLICIES.renewal,
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: new URL(".", root),
    encoding: "utf8",
    env: { ...process.env, OPS_HIGH_FREQUENCY_CRON: "1" },
  });

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.scheduler, {
    mode: "external_hourly",
    cadenceMs: 60 * 60_000,
    missedAfterMs: 150 * 60_000,
  });
  assert.equal(result.routine.cadenceMs, 60 * 60_000);
  assert.equal(result.routine.missedAfterMs, 150 * 60_000);
  assert.equal(result.renewal.cadenceMs, 6 * 60 * 60_000);
  assert.equal(result.renewal.missedAfterMs, 12 * 60 * 60_000);
});
