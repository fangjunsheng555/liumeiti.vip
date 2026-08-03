import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  localDateTimeToIso,
  validateMarketingCampaignDates,
} from "../app/admin/marketing-campaign-form.js";

test("campaign dates parse safely and an offer must outlive its scheduled send", () => {
  const now = Date.parse("2026-08-03T00:00:00.000Z");
  assert.equal(localDateTimeToIso(""), "");
  assert.equal(localDateTimeToIso("not-a-date"), "");
  assert.equal(validateMarketingCampaignDates({ scheduledAt: "" }, now).ok, false);
  assert.equal(validateMarketingCampaignDates({ scheduledAt: "not-a-date" }, now).ok, false);
  const expiredAtSend = validateMarketingCampaignDates({
    scheduledAt: "2026-08-03T01:00:00.000Z",
    endsAt: "2026-08-03T00:30:00.000Z",
  }, now);
  assert.equal(expiredAtSend.ok, false);
  assert.match(expiredAtSend.error, /晚于计划发送时间/);
  assert.equal(validateMarketingCampaignDates({
    scheduledAt: "2026-08-03T01:00:00.000Z",
    endsAt: "2026-08-04T01:00:00.000Z",
  }, now).ok, true);
});

test("campaign UI never calls toISOString on unchecked form input and hides cancel for failed terminal state", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /new Date\(form\.(?:scheduledAt|endsAt)\)\.toISOString\(\)/);
  assert.match(source, /disabled=\{Boolean\(state\.busy\) \|\| !dateValidation\.ok\}/);
  assert.match(source, /\['completed', 'cancelled', 'failed'\]\.includes\(campaign\.status\)/);
});

test("campaign UI has responsive detail actions, explicit empty state and announced feedback", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /flexWrap:\s*"wrap"[\s\S]*?selectedStats\.campaign\.name/);
  assert.match(source, /暂无营销活动/);
  assert.match(source, /<span role="alert"/);
  assert.match(source, /<span role="status"/);
  assert.match(source, /opacity:\s*state\.busy \|\| !dateValidation\.ok \? 0\.55 : 1/);
});

test("campaign UI states the Hobby hourly dispatch precision honestly", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /计划时间后的下一次小时巡检发送，最多约 1 小时/);
  assert.match(source, /不是精确到分钟的承诺/);
  assert.match(source, /role="note"/);
});

test("server rejects offers ending before schedule and cron exposes every dispatch failure as 503", async () => {
  const campaignRoute = await readFile(new URL("../app/api/admin/mail/campaign/route.js", import.meta.url), "utf8");
  const cronRoute = await readFile(new URL("../app/api/cron/marketing-campaign/route.js", import.meta.url), "utf8");
  assert.match(campaignRoute, /offerEndsAtMs\s*&&\s*offerEndsAtMs\s*<=\s*scheduledMs/);
  assert.match(campaignRoute, /offer_ends_before_schedule/);
  assert.match(campaignRoute, /JOB_POLICIES\.marketing_dispatch\.cadenceMs/);
  assert.match(campaignRoute, /dispatchRule:\s*"next_scheduler_sweep"/);
  assert.match(cronRoute, /status:\s*result\?\.ok\s*===\s*false\s*\?\s*503\s*:\s*200/);
  assert.doesNotMatch(cronRoute, /!result\?\.submitted/);
});

test("legacy bulk scheduler gives each recipient batch its own campaign idempotency key", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  assert.match(source, /const campaignGroupId = `MC\$\{Date\.now\(\)\.toString\(36\)\.toUpperCase\(\)\}`/);
  assert.match(source, /const campaignId = `\$\{campaignGroupId\}-D\$\{dayIndex \+ 1\}-B\$\{requestIndex \+ 1\}`/);
  assert.doesNotMatch(source, /const campaignId = `MC\$\{Date\.now\(\)\.toString\(36\)\.toUpperCase\(\)\}`/);
});
