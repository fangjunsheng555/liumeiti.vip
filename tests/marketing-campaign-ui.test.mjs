import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  localDateTimeToIso,
  validateMarketingCampaignDates,
} from "../app/admin/marketing-campaign-form.js";

const nodeRequire = createRequire(import.meta.url);
let panelFunctionsPromise;

async function panelFunctions() {
  if (!panelFunctionsPromise) panelFunctionsPromise = (async () => {
    const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
    const swc = await import("next/dist/build/swc/index.js");
    await swc.loadBindings();
    const compiled = await swc.transform(source, {
      filename: "MarketingCampaignPanel.jsx",
      jsc: { parser: { syntax: "ecmascript", jsx: true }, target: "es2022", transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" },
    });
    const module = { exports: {} };
    const localRequire = (specifier) => {
      if (specifier === "./marketing-campaign-form.js") return { validateMarketingCampaignDates: () => ({ ok: true, scheduledIso: "", endsAtIso: "" }) };
      if (specifier === "../lib/client-fetch") return { clientFetch: async () => { throw new Error("fetch not available in payload tests"); } };
      if (specifier === "../lib/latest-request") return { beginLatestRequest: () => 1, invalidateLatestRequest: () => {}, isLatestRequest: () => true };
      return nodeRequire(specifier);
    };
    Function("module", "exports", "require", compiled.code)(module, module.exports, localRequire);
    return module.exports;
  })();
  return panelFunctionsPromise;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const attribution = { saleCount: 0, revenue: 0, conversionRate: 0, clickThroughRate: 0 };

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
  assert.match(expiredAtSend.error, /最晚派发时间必须晚于开始排期时间/);
  assert.equal(validateMarketingCampaignDates({
    scheduledAt: "2026-08-03T01:00:00.000Z",
    endsAt: "2026-08-04T01:00:00.000Z",
  }, now).ok, true);
});

test("campaign UI never calls toISOString on unchecked form input and hides cancel for failed terminal state", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /new Date\(form\.(?:scheduledAt|endsAt)\)\.toISOString\(\)/);
  assert.match(source, /if \(!mailPreviewCurrent \|\| !audiencePreviewCurrent \|\| selectedCount < 1 \|\| audienceTruncated\)/);
  assert.match(source, /disabled=\{Boolean\(state\.busy\) \|\| !dateValidation\.ok \|\| !mailPreviewCurrent \|\| !audiencePreviewCurrent \|\| selectedCount < 1 \|\| audienceTruncated\}/);
  assert.match(source, /\['completed', 'cancelled', 'failed'\]\.includes\(campaign\.status\)/);
});

test("campaign UI has responsive detail actions, explicit empty state and announced feedback", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /marketing-campaign-stats[\s\S]*?selectedStats\.campaign\.name/);
  assert.match(source, /暂无营销活动/);
  assert.match(source, /role="alert"/);
  assert.match(source, /role="status"/);
  assert.match(source, /活动列表加载失败，当前空白不代表没有活动/);
});

test("campaign list and stats reject malformed HTTP-200 payloads without manufacturing empty or zero data", async () => {
  const { campaignsFromPayload, campaignStatsFromPayload } = await panelFunctions();
  const previous = [{ id: "CMP-OLD", counters: {}, attribution }];
  const validRows = [{ id: "CMP-NEW", counters: { queued: 0 }, attribution }];
  assert.strictEqual(campaignsFromPayload({ ok: true, campaigns: validRows }), validRows);
  assert.throws(() => campaignsFromPayload({ ok: true }), /活动列表格式异常/);
  assert.throws(() => campaignsFromPayload({ ok: true, campaigns: [{ id: "CMP-BAD" }] }), /活动列表格式异常/);
  let current = previous;
  try { current = campaignsFromPayload({ ok: true }); } catch {}
  assert.strictEqual(current, previous, "malformed success payload must not replace the current campaign list");

  const validStats = { ok: true, campaign: { id: "CMP-NEW", name: "新活动" }, counters: {}, attribution };
  assert.strictEqual(campaignStatsFromPayload(validStats, "CMP-NEW"), validStats);
  assert.throws(() => campaignStatsFromPayload({ ok: true }, "CMP-NEW"), /活动统计格式异常/);
  assert.throws(() => campaignStatsFromPayload({ ...validStats, campaign: { id: "CMP-OTHER" } }, "CMP-NEW"), /活动统计格式异常/);
  assert.throws(() => campaignStatsFromPayload({ ...validStats, attribution: {} }, "CMP-NEW"), /活动统计格式异常/);
});

test("preview, audience and schedule success bodies are validated before UI success mutations", async () => {
  const { campaignActionFromPayload, campaignManagementFromPayload } = await panelFunctions();
  const preview = { ok: true, html: "<p>真实预览</p>", contentHash: HASH_A, offerSnapshotHash: HASH_B };
  assert.strictEqual(campaignActionFromPayload("preview", preview), preview);
  assert.throws(() => campaignActionFromPayload("preview", { ok: true, html: "", contentHash: HASH_A, offerSnapshotHash: HASH_B }), /预览返回不完整/);
  assert.throws(() => campaignActionFromPayload("preview", { ok: true, html: "<p>x</p>", contentHash: "bad", offerSnapshotHash: HASH_B }), /预览返回不完整/);

  const audience = { ok: true, audience: { snapshotHash: HASH_A, snapshot: {
    candidateCount: 3, matchedCount: 3, eligibleCount: 2, selectedCount: 2, suppressedCount: 1, invalidManualCount: 0,
    truncated: false, sourceTruncated: false, manualTruncated: false,
  } } };
  assert.strictEqual(campaignActionFromPayload("audience", audience), audience);
  assert.throws(() => campaignActionFromPayload("audience", { ok: true, audience: { snapshot: audience.audience.snapshot } }), /核对结果不完整/);
  assert.throws(() => campaignActionFromPayload("audience", { ok: true, audience: { ...audience.audience, snapshot: { ...audience.audience.snapshot, selectedCount: 2.5 } } }), /核对结果不完整/);

  const scheduled = { ok: true, scheduledCount: 0, suppressedCount: 3 };
  assert.strictEqual(campaignActionFromPayload("schedule", scheduled), scheduled);
  assert.throws(() => campaignActionFromPayload("schedule", { ok: true }), /排期结果不完整/);
  assert.throws(() => campaignActionFromPayload("schedule", { ok: true, scheduledCount: 1, suppressedCount: -1 }), /排期结果不完整/);

  const paused = { ok: true, campaign: { id: "CMP-1", status: "paused" } };
  assert.strictEqual(campaignManagementFromPayload(paused, "CMP-1", "pause"), paused);
  assert.throws(() => campaignManagementFromPayload({ ok: true }, "CMP-1", "pause"), /状态返回格式异常/);
  assert.throws(() => campaignManagementFromPayload({ ok: true, campaign: { id: "CMP-1", status: "scheduled" } }, "CMP-1", "pause"), /状态返回格式异常/);
});

test("catalog rereads invalidate every preview credential before network work and stats expose a retry", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  const start = source.indexOf("const loadCatalog = useCallback");
  const fetchAt = source.indexOf('fetch("/api/catalog"', start);
  assert.ok(start >= 0 && fetchAt > start);
  for (const statement of ['setPreview("")', 'setMailContentHash("")', 'setOfferSnapshotHash("")', 'setMailPreviewSignature("")']) {
    const at = source.indexOf(statement, start);
    assert.ok(at > start && at < fetchAt, `${statement} must run before the catalog request`);
  }
  assert.match(source, /const nextCampaigns = campaignsFromPayload\(data\)[\s\S]*?setCampaigns\(nextCampaigns\)/);
  assert.match(source, /const nextStats = campaignStatsFromPayload\(data, campaign\.id\)[\s\S]*?setSelectedStats\(nextStats\)/);
  assert.match(source, /统计未更新：[\s\S]*?onClick=\{\(\) => viewStats\(statsRetryCampaign\)\}[\s\S]*?重试统计/);
  assert.match(source, /setStatsError\(error\.message \|\| "活动统计加载失败"\);[\s\S]*?setState\(\{ busy: "", message: "", error: "" \}\)/);
  assert.match(source, /const validated = campaignActionFromPayload\(kind, data\)[\s\S]*?setState\(\{ busy: ""/);
});

test("campaign UI states the Resend daily limit and natural-day rollover honestly", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /系统在下一次队列巡检时开始发送/);
  assert.match(source, /营销邮件固定使用 Resend/);
  assert.match(source, /每个北京时间自然日最多提交 \{DAILY_MARKETING_LIMIT\} 封/);
  assert.match(source, /超出的名单自动顺延到后续日期/);
  assert.doesNotMatch(source, /Hobby/);
  assert.match(source, /role="note"/);
});

test("campaign editor stays compact and only exposes site-backed marketing content fields", async () => {
  const source = await readFile(new URL("../app/admin/MarketingCampaignPanel.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(source, /className="marketing-campaign-basics-grid"/);
  assert.match(source, /className="marketing-campaign-field-grid"/);
  assert.match(source, /className="marketing-campaign-card marketing-campaign-preview"/);
  assert.match(source, /CAMPAIGN_STATUS_LABELS\[campaign\.status\]/);
  assert.match(source, /timeZone: "Asia\/Shanghai"/);
  assert.doesNotMatch(source, /minHeight:\s*720/);
  assert.match(css, /\.marketing-campaign-basics-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(175px,\s*1fr\)\)/);
  assert.match(css, /\.marketing-campaign-field-grid\s*\{[\s\S]*?repeat\(2,/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.marketing-campaign-field-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /\.marketing-campaign-preview iframe\s*\{[\s\S]*?height:\s*460px/);
  assert.match(source, /campaignId: form\.campaignId,[\s\S]*?name: form\.name \|\| form\.subject,[\s\S]*?subject: form\.subject/);
  assert.match(source, /scheduledAt: dateValidation\.scheduledIso/);
  assert.match(source, /segment,[\s\S]*?manualRecipients: form\.manualRecipients,[\s\S]*?maxRecipients: Number\(form\.maxRecipients \|\| 2000\),[\s\S]*?audienceSnapshotHash: audience\.snapshotHash,[\s\S]*?mailContentHash,[\s\S]*?offerSnapshotHash,[\s\S]*?offer/);
  assert.match(source, /max="2000"/);
  assert.match(source, /audienceTruncated[\s\S]*?manualTruncated[\s\S]*?sourceTruncated/);
  assert.match(source, /完整名单来源已超过系统读取容量/);
  assert.match(source, /调整本页人数或筛选条件无法保证覆盖/);
  assert.match(source, /featuredServiceKeys/);
  assert.match(source, /const mailPreviewCurrent = Boolean\(preview && mailContentHash && offerSnapshotHash && mailPreviewSignature === currentMailSignature\)/);
  assert.match(source, /const audiencePreviewCurrent = Boolean\(audience\?\.snapshotHash && audiencePreviewSignature === currentAudienceSignature\)/);
  assert.match(source, /offer_snapshot_changed:\s*"[^"]+重新预览[^"]*"/);
  assert.match(source, /audience_preview_required:\s*"[^"]+核对[^"]*"/);
  assert.match(source, /invalid_segment:\s*"[^"]*收件人条件无效[^"]*"/);
  assert.match(source, /\(product\.plans \|\| \[\]\)\.some\(\(plan\) => plan\?\.active !== false && !plan\?\.soldOut\)/);
  assert.doesNotMatch(source, /couponCode|originalPrice|currentPrice|savingText/);
  assert.doesNotMatch(source, /优惠码|原价文案|优惠价文案|节省文案|立省/);
});

test("server rejects offers ending before schedule and cron exposes every dispatch failure as 503", async () => {
  const campaignRoute = await readFile(new URL("../app/api/admin/mail/campaign/route.js", import.meta.url), "utf8");
  const cronRoute = await readFile(new URL("../app/api/cron/marketing-campaign/route.js", import.meta.url), "utf8");
  assert.match(campaignRoute, /offerEndsAtMs\s*&&\s*offerEndsAtMs\s*<=\s*scheduledMs/);
  assert.match(campaignRoute, /offer_ends_before_schedule/);
  assert.match(campaignRoute, /JOB_POLICIES\.marketing_dispatch\.cadenceMs/);
  assert.match(campaignRoute, /dispatchRule:\s*"next_scheduler_sweep"/);
  assert.match(campaignRoute, /export const maxDuration = 60/);
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
  assert.match(source, /右上角用于发送客服邮件；批量营销请进入“营销活动”/);
  assert.doesNotMatch(source, /右上角可发客服或批量营销邮件/);
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
  assert.match(source, /核对邮件[\s\S]*?核对收件人[\s\S]*?确认排期/);
  assert.match(source, /marketing-campaign-list[\s\S]*?<details className="marketing-campaign-create"/);
  assert.match(source, /<details[\s\S]*?className="marketing-campaign-create"[\s\S]*?open=\{editorOpen\}/);
  assert.match(source, /固定合并手工名单、全部注册账号与全部历史下单邮箱/);
  assert.match(source, /手工名单（每行一个，也可用逗号分隔）/);
  assert.match(source, /邮件重点展示服务（最多展示前 3 项）/);
  assert.match(source, /仅筛选站内用户：购买过的服务/);
  assert.match(source, /最近购买（天内）/);
  assert.match(source, /最低累计消费（元）/);
  assert.match(source, /服务到期（天内）/);
  assert.match(source, /邮件正文[\s\S]*?中文（本模板仅生成中文正文）/);
  assert.match(source, /格式无效、退订、硬退信或投诉地址会被跳过/);
  assert.match(source, /state\.error[\s\S]*?marketing-campaign-list[\s\S]*?<details className="marketing-campaign-create"/);
});

test("mail workspace remains usable on desktop and mobile", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.admin-mail-workspace-header\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0/);
  assert.match(css, /\.admin-mail-workspace-tabs\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,/);
  assert.match(css, /\.admin-mail-workspace-panel\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.admin-mail-workspace-header\s*\{\s*top:\s*53px/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.admin-mail-workspace-tabs > button\s*\{\s*min-height:\s*43px/);
});
