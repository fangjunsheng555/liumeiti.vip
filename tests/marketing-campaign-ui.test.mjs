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
  assert.match(source, /role="alert"/);
  assert.match(source, /role="status"/);
  assert.match(source, /opacity:\s*state\.busy \|\| !dateValidation\.ok \? 0\.55 : 1/);
});

test("campaign UI states the Hobby hourly dispatch precision honestly", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /计划时间后的下一次小时巡检发送，最多约 1 小时/);
  assert.match(source, /不是精确到分钟的承诺/);
  assert.match(source, /role="note"/);
});

test("campaign editor stays compact and responsive without changing its submission fields", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(source, /className="marketing-campaign-basics-grid"/);
  assert.match(source, /className="marketing-campaign-field-grid"/);
  assert.match(source, /className="marketing-campaign-card marketing-campaign-preview"/);
  assert.match(source, /CAMPAIGN_STATUS_LABELS\[campaign\.status\]/);
  assert.match(source, /timeZone: "Asia\/Shanghai"/);
  assert.doesNotMatch(source, /minHeight:\s*720/);
  assert.match(css, /\.marketing-campaign-basics-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,/);
  assert.match(css, /\.marketing-campaign-field-grid\s*\{[\s\S]*?repeat\(2,/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.marketing-campaign-field-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /\.marketing-campaign-preview iframe\s*\{[\s\S]*?height:\s*460px/);
  assert.match(source, /campaignId: form\.campaignId, name: form\.name \|\| form\.subject, subject: form\.subject/);
  assert.match(source, /scheduledAt: dateValidation\.scheduledIso/);
  assert.match(source, /segment, maxRecipients: Number\(form\.maxRecipients \|\| 500\), offer/);
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

test("mail workspace opens on records and keeps the send action visible", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  assert.match(source, /const \[mailWorkspace, setMailWorkspace\] = useState\("records"\)/);
  assert.match(source, /className="admin-mail-workspace-header"/);
  assert.match(source, /role="tablist" aria-label="客服发信工作区"/);
  assert.match(source, /aria-selected=\{mailWorkspace === "records"\}/);
  assert.match(source, /aria-selected=\{mailWorkspace === "campaigns"\}/);
  assert.match(source, /className="admin-mail-primary-action"[\s\S]*?aria-label="发信"[\s\S]*?openMailComposer\("customer"\)/);
});

test("mail records and campaign editor are separate persistent workspaces", async () => {
  const source = await readFile(new URL("../app/admin/page.jsx", import.meta.url), "utf8");
  assert.match(source, /id="admin-mail-campaigns-panel"[\s\S]*?hidden=\{mailWorkspace !== "campaigns"\}[\s\S]*?<MarketingCampaignPanel \/>/);
  assert.match(source, /id="admin-mail-records-panel"[\s\S]*?hidden=\{mailWorkspace !== "records"\}[\s\S]*?className="admin-mail-log"/);
  assert.match(source, /if \(it\.key === "mail"\) setMailWorkspace\("records"\)/);
  assert.match(source, /event\.target !== event\.currentTarget[\s\S]*?\["Enter", " "\]/);
});

test("campaign workspace explains the workflow and keeps its long editor collapsed", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /const \[editorOpen, setEditorOpen\] = useState\(false\)/);
  assert.match(source, /aria-label="营销活动使用步骤"/);
  assert.match(source, /设置活动[\s\S]*?选择收件人[\s\S]*?预览并排期/);
  assert.match(source, /<details[\s\S]*?className="marketing-campaign-create"[\s\S]*?open=\{editorOpen\}/);
  assert.match(source, /购买过的服务（逗号分隔，留空不限）/);
  assert.match(source, /最近购买（天内，留空不限）/);
  assert.match(source, /最低累计消费（元）/);
  assert.match(source, /服务到期（天内，留空不限）/);
  assert.match(source, /邮件语言（不选则全部）/);
  assert.match(source, /自动跳过退订、退信和投诉地址/);
  assert.match(source, /<\/details>[\s\S]*?marketing-campaign-feedback error[\s\S]*?marketing-campaign-list/);
  assert.match(source, /<\/details>[\s\S]*?marketing-campaign-feedback success[\s\S]*?marketing-campaign-list/);
});

test("mail workspace remains usable on desktop and mobile", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.admin-mail-workspace-header\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0/);
  assert.match(css, /\.admin-mail-workspace-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,/);
  assert.match(css, /\.admin-mail-workspace-panel\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.admin-mail-workspace-header\s*\{\s*top:\s*53px/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.admin-mail-workspace-tabs > button\s*\{\s*min-height:\s*43px/);
});
