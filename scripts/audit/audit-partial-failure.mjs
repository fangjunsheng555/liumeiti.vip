import path from "node:path";
import { createHash } from "node:crypto";
import {
  auditRoot, finding, finish, nodeText, parseModule, sourceFile, visit, walkFiles,
} from "./_shared.mjs";

/*
 * Partial-failure audit
 * ---------------------
 * This check is deliberately limited to read/list shapes where rejecting one
 * malformed member can hide otherwise usable records.  A match may be
 * suppressed only in ALLOW after it has been classified as a transport-level
 * failure, a pre-write integrity check, or a deliberately strict single-record
 * read.  Keeping those decisions here makes the exceptions reviewable instead
 * of teaching the scanner to ignore broad classes of failures.
 */

const root = auditRoot();
const findings = [];

// Broad classifications are documentation only.  A classification does not
// suppress a finding by itself: the exact normalized AST node must also be in
// ALLOW_FINGERPRINTS below (or carry an adjacent, rule-specific safety comment).
// This prevents a newly-added unsafe branch in a previously reviewed function
// from inheriting the function's old exemption.
const ALLOW_CLASSIFICATIONS = new Map([
  // Single HTTP response / write-input contracts: there is no independent
  // list member to salvage.
  ["app/admin/MarketingCampaignPanel.jsx|campaignActionFromPayload|partial-failure-predicate-abort", "single-response schema validation"],
  ["app/lib/admin-mutation-journal.js|persistExactRecord|partial-failure-predicate-abort", "pre-write operation integrity"],
  ["app/lib/checkout-pending-journal.js|writeCheckoutPendingJournal|partial-failure-predicate-abort", "pre-write operation integrity"],

  // Optional presentation rows / intentionally irrelevant records.
  ["app/admin/page.jsx|orderPdfRows|partial-failure-silent-filter", "optional PDF detail rows"],
  ["app/api/admin/netflix-code/route.js|netflixOrdersFromDirectory|partial-failure-silent-filter", "non-Netflix orders are intentionally excluded"],
  ["app/api/_usdt-confirm.js|normalizeConfirmedUsdtTransfers|partial-failure-silent-filter", "provider rows that are not confirmed USDT transfers are intentionally excluded"],
  ["app/page.jsx|Page|partial-failure-silent-filter", "catalog products without a homepage service card are intentionally excluded"],
  ["app/lib/store.js|getCatalogProducts|partial-failure-silent-filter", "catalog keys without a compiled product implementation are intentionally excluded"],

  // Transport-layer pipeline completeness.  A failed command means Redis did
  // not provide a trustworthy batch; returning a partial batch would invent a
  // healthy state.
  ["app/api/_backup.js|readEntries|partial-failure-predicate-abort", "complete backup transport check"],
  ["app/api/_backup.js|strictPipelineValues|partial-failure-map-throw", "transport helper rejects incomplete/error pipeline members"],
  ["app/api/_backup.js|readEntries|partial-failure-loop-throw", "complete backup refuses unsupported Redis value types instead of producing an incomplete archive"],
  ["app/api/_backup.js|normalizeStream|partial-failure-map-throw", "backup normalization aborts before writing an incomplete archive"],
  ["app/api/_backup.js|runRestoreDrill|partial-failure-predicate-abort", "restore write/read verification"],
  ["app/api/_health.js|strictPipelineRows|partial-failure-map-throw", "transport helper"],
  ["app/api/_incidents.js|strictPipelineRows|partial-failure-map-throw", "transport helper"],
  ["app/api/_job-runner.js|strictPipelineRows|partial-failure-map-throw", "transport helper"],
  ["app/api/_mail-delivery.js|checkedPipelineRows|partial-failure-predicate-abort", "transport helper"],
  ["app/api/_mail-preferences.js|checkedPipelineRows|partial-failure-predicate-abort", "transport helper"],
  ["app/api/_observability.js|readMetricSeries|partial-failure-predicate-abort", "metric pipeline transport check"],
  ["app/api/_order-credential-mirror-backfill.js|strictPipeline|partial-failure-predicate-abort", "transport helper"],
  ["app/api/_settings.js|strictPipelineValues|partial-failure-map-throw", "transport helper"],
  ["app/api/_telegram-alerts.js|strictPipelineRows|partial-failure-map-throw", "transport helper"],
  ["app/api/admin/mail/marketing-data.js|strictCatalogOverrides|partial-failure-predicate-abort", "authoritative catalog transport check"],
  ["app/api/admin/mail/marketing-data.js|strictCatalogStockMap|partial-failure-predicate-abort", "authoritative stock transport check"],
  ["app/api/admin/mail/marketing-data.js|strictCatalogStockMap|partial-failure-loop-throw", "authoritative stock validation; never advertise an incorrect price or stock state"],
  ["app/api/_catalog-versions.js|listCatalogVersions|partial-failure-predicate-abort", "current pointer/index/PING transport and key-type check"],

  // Maintenance/write workflows must preserve all-or-nothing semantics.
  ["app/api/_observability.js|sampleOperationalQueues|partial-failure-predicate-abort", "snapshot write verification"],
  ["app/api/_order-credential-mirror-backfill.js|defaultReadPage|partial-failure-map-throw", "migration stops without advancing its cursor"],
  ["app/api/_keeper.js|handler|partial-failure-loop-throw", "maintenance runner propagates failed sub-jobs without discarding read records"],
  ["app/api/_job-runner.js|detectMissedJobs|partial-failure-loop-throw", "deadline guard, not per-record validation"],
  ["app/api/_utils.js|settleOrderReferralCommission|partial-failure-every-empty", "financial effects are verified as one settlement"],

  // The order overview is derived state.  Any malformed member triggers a
  // fenced rebuild from authoritative records.  Financial strict reads abort
  // rather than publish understated revenue (decision rule: never return the
  // wrong money outranks partial availability).
  ["app/api/_utils.js|getAllOrdersStrict|partial-failure-predicate-abort", "strict financial source transport/integrity"],
  ["app/api/_utils.js|getAllOrdersStrict|partial-failure-map-throw", "strict financial source integrity"],
  ["app/api/_utils.js|getAllOrdersStrict|partial-failure-loop-throw", "strict financial source integrity"],
  ["app/api/_utils.js|getAllOrdersStrict|partial-failure-silent-filter", "invalid index IDs are counted and warned; financial record bodies remain strict"],
  ["app/api/_utils.js|backfillOrderIndexMembership|partial-failure-silent-filter", "invalid legacy index IDs are counted and warned before migration"],
  ["app/api/_utils.js|readyOrderOverviewRows|partial-failure-predicate-abort", "derived cache rebuild trigger"],
  ["app/api/_utils.js|readyOrderOverviewRows|partial-failure-every-empty", "derived cache rebuild trigger"],
  ["app/api/_utils.js|readyOrderOverviewRows|partial-failure-silent-filter", "derived-cache ID validation is followed by a full count/uniqueness fence and rebuild"],
  ["app/api/_utils.js|rebuildOrderOverviewRows|partial-failure-silent-filter", "deleted records are intentionally absent from the overview"],
  ["app/api/_utils.js|getOrderListRevision|partial-failure-predicate-abort", "transport check"],
  ["app/api/_utils.js|getOrderSummariesPageFast|partial-failure-predicate-abort", "transport check with record recovery below"],
  ["app/api/_utils.js|getOrderSummariesPageFast|partial-failure-silent-filter", "missing summaries are recovered/pruned before this projection"],
  ["app/api/_utils.js|listAllUserEmailsStrict|partial-failure-predicate-abort", "transport check"],
  ["app/api/_utils.js|redeemGuardPipelineRows|partial-failure-predicate-abort", "security guard transport check"],
  ["app/api/_utils.js|listWithdrawals|partial-failure-predicate-abort", "per-command Redis transport check; malformed withdrawal bodies are skipped and reported separately"],

  // Input normalization: these values are not records read from storage.
  ["app/api/_utils.js|getOrdersByIds|partial-failure-silent-filter", "caller-supplied order-id normalization"],
  ["app/api/_utils.js|getOrdersByIds|partial-failure-loop-throw", "per-command transport error; malformed records are skipped and reported separately"],
  ["app/api/_marketing-campaign-queue.js|getMarketingCampaignCountersBatch|partial-failure-silent-filter", "caller-supplied campaign-id normalization"],
  ["app/api/_mail-preferences.js|getMailSendDecisionsBatch|partial-failure-silent-filter", "caller-supplied email normalization; invalid addresses receive no send decision"],
  ["app/api/_mail-preferences.js|listMailSuppressions|partial-failure-silent-filter", "corrupt derived contacts are counted and warned immediately before projection"],
  ["app/api/_marketing-campaign-queue.js|normalizeRecipients|partial-failure-silent-filter", "caller-supplied recipient normalization"],
  ["app/api/_marketing-campaign-queue.js|enqueueMarketingCampaign|partial-failure-silent-filter", "pre-write recipient normalization; an empty result is rejected below"],
  ["app/api/netflix-code/_store.js|storeNetflixMailEvent|partial-failure-silent-filter", "hash projection of already-normalized account addresses"],
  ["app/api/after-sales/_store.js|getActiveAfterSalesTickets|partial-failure-silent-filter", "caller-supplied order-id normalization"],
  ["app/api/admin/overview/route.js|GET|partial-failure-silent-continue", "orders outside the selected date/status window are intentionally excluded"],
  ["app/api/admin/netflix-code/route.js|GET|partial-failure-silent-continue", "access rows without both optional relation keys cannot participate in event-to-order grouping"],
  ["app/admin/NetflixCodePanel.jsx|removeRecords|partial-failure-loop-throw", "batch write response handling; the UI reloads committed batches and reports partial completion"],
  ["app/api/_mail-preferences.js|repairCorruptContact|partial-failure-predicate-abort", "pre-write conservative repair payload validation"],
  ["app/api/_marketing-campaign-queue.js|readCampaignJobs|partial-failure-predicate-abort", "campaign cancellation must account for every queued job"],
  ["app/api/_marketing-campaign-queue.js|readCampaignJobs|partial-failure-every-empty", "campaign cancellation must account for every queued job"],
  ["app/api/_money.js|losslessJsonPatchBatch|partial-failure-predicate-abort", "single-document lossless patch conflict validation"],
  ["app/api/admin/after-sales/notify-by-reference/route.js|overlayCurrentOrderCredentials|partial-failure-predicate-abort", "single planned-order identity guard"],
  ["app/api/admin/mail/audience-data.js|buildMailAudience|partial-failure-predicate-abort", "marketing consent decisions must be complete before any send"],
  ["app/api/admin/mail/marketing-data.js|buildMarketingArgs|partial-failure-predicate-abort", "do not render a campaign from an empty live catalog"],
  ["app/api/admin/insights/route.js|strictRedisValues|partial-failure-predicate-abort", "transport helper rejects undefined command values"],
  ["app/api/admin/insights/route.js|GET|partial-failure-predicate-abort", "authoritative analytics and revenue aggregate integrity"],
]);

// Filled only after a concrete node has been reviewed.  The digest is over
// normalized node source (comments and insignificant whitespace removed), so
// line movement is harmless while a logic change invalidates the exemption.
const ALLOW_FINGERPRINTS = new Map([
  ["app/admin/MarketingCampaignPanel.jsx|campaignActionFromPayload|partial-failure-predicate-abort", new Set(["0b670a88a8ddc12ddcf8"])],
  ["app/admin/NetflixCodePanel.jsx|removeRecords|partial-failure-loop-throw", new Set(["0550d6a3d2abb4c924a3"])],
  ["app/admin/page.jsx|orderPdfRows|partial-failure-silent-filter", new Set(["663a5af040c701959287"])],
  ["app/api/_backup.js|normalizeStream|partial-failure-map-throw", new Set(["f752e12b44dac4ed4869"])],
  ["app/api/_backup.js|readEntries|partial-failure-loop-throw", new Set(["3c2e4f4118d2d0e89d32"])],
  ["app/api/_backup.js|strictPipelineValues|partial-failure-map-throw", new Set(["5c0274e75d28e61c1add"])],
  ["app/api/_catalog-versions.js|listCatalogVersions|partial-failure-predicate-abort", new Set(["3adbfb9194ba741064a3"])],
  ["app/api/_health.js|strictPipelineRows|partial-failure-map-throw", new Set(["564b38b1f798a5644f1a"])],
  ["app/api/_incidents.js|strictPipelineRows|partial-failure-map-throw", new Set(["3d39b0a0a9dc9197ab50"])],
  ["app/api/_job-runner.js|strictPipelineRows|partial-failure-map-throw", new Set(["4d059c37668d4ec323d3"])],
  ["app/api/_job-runner.js|detectMissedJobs|partial-failure-loop-throw", new Set(["07eb3ceba4b69c84a3b7"])],
  ["app/api/_keeper.js|handler|partial-failure-loop-throw", new Set(["7ef9d0c19e673f5d561f", "6730e9d5c96eb4adf625"])],
  ["app/api/_mail-delivery.js|checkedPipelineRows|partial-failure-predicate-abort", new Set(["3e1c0154f7a259e0f197"])],
  ["app/api/_mail-preferences.js|checkedPipelineRows|partial-failure-predicate-abort", new Set(["f974b29708d81351b6b3"])],
  ["app/api/_mail-preferences.js|repairCorruptContact|partial-failure-predicate-abort", new Set(["e3dd94911d89cab17766"])],
  ["app/api/_mail-preferences.js|getMailSendDecisionsBatch|partial-failure-silent-filter", new Set(["ab457ddede8dd766506e"])],
  ["app/api/_mail-preferences.js|listMailSuppressions|partial-failure-silent-filter", new Set(["3a6301b8f737709445ea"])],
  ["app/api/_marketing-campaign-queue.js|normalizeRecipients|partial-failure-silent-filter", new Set(["4263fe01fc6e9b27580e"])],
  ["app/api/_marketing-campaign-queue.js|readCampaignJobs|partial-failure-predicate-abort", new Set(["7a423a9c58b3f3bd4b9b"])],
  ["app/api/_marketing-campaign-queue.js|readCampaignJobs|partial-failure-every-empty", new Set(["0b636c37df4ea3aba07c"])],
  ["app/api/_marketing-campaign-queue.js|getMarketingCampaignCountersBatch|partial-failure-silent-filter", new Set(["655779d2a64f2e663711"])],
  ["app/api/_marketing-campaign-queue.js|enqueueMarketingCampaign|partial-failure-silent-filter", new Set(["7b13953410bdfadd5c00"])],
  ["app/api/_money.js|losslessJsonPatchBatch|partial-failure-predicate-abort", new Set(["b98827b11a68b758ec4f"])],
  ["app/api/_observability.js|readMetricSeries|partial-failure-predicate-abort", new Set(["1f602c5a266a7b2025a3"])],
  ["app/api/_observability.js|sampleOperationalQueues|partial-failure-predicate-abort", new Set(["2962d1b8998f6aa708fa"])],
  ["app/api/_order-credential-mirror-backfill.js|strictPipeline|partial-failure-predicate-abort", new Set(["a7c3f3c212a36e08f6cf"])],
  ["app/api/_order-credential-mirror-backfill.js|defaultReadPage|partial-failure-map-throw", new Set(["8e4b854e4f2cfb119129", "7f34d9dbd3eb9b93b7cf"])],
  ["app/api/_settings.js|strictPipelineValues|partial-failure-map-throw", new Set(["438a62aa3e2063dd9f34"])],
  ["app/api/_telegram-alerts.js|strictPipelineRows|partial-failure-map-throw", new Set(["7dec7247e2337908e3a2"])],
  ["app/api/_usdt-confirm.js|normalizeConfirmedUsdtTransfers|partial-failure-silent-filter", new Set(["894b743551f41e07a3e0"])],
  ["app/api/_utils.js|getOrdersByIds|partial-failure-silent-filter", new Set(["70c397afbbb16ef4370e"])],
  ["app/api/_utils.js|getOrdersByIds|partial-failure-loop-throw", new Set(["c7af661ec77e87930c52"])],
  ["app/api/_utils.js|getAllOrdersStrict|partial-failure-predicate-abort", new Set(["f3ca68f1afa8e33301ec", "41b25b52a7a6476b8361"])],
  ["app/api/_utils.js|getAllOrdersStrict|partial-failure-map-throw", new Set(["9f425da74f470f8458b1"])],
  ["app/api/_utils.js|getAllOrdersStrict|partial-failure-loop-throw", new Set(["74d3bf89645230069b89"])],
  ["app/api/_utils.js|getAllOrdersStrict|partial-failure-silent-filter", new Set(["f13422b014fe34e8bc5a"])],
  ["app/api/_utils.js|backfillOrderIndexMembership|partial-failure-silent-filter", new Set(["b60e6aa89ce1ca299d48"])],
  ["app/api/_utils.js|readyOrderOverviewRows|partial-failure-predicate-abort", new Set(["d24eaf02bbc57bfa02e4"])],
  ["app/api/_utils.js|readyOrderOverviewRows|partial-failure-silent-filter", new Set(["4de6a695ee8c586b93c0"])],
  ["app/api/_utils.js|readyOrderOverviewRows|partial-failure-every-empty", new Set(["df3ed94ccbbb6aee3f5f"])],
  ["app/api/_utils.js|rebuildOrderOverviewRows|partial-failure-silent-filter", new Set(["8e77f39441b918b91b73"])],
  ["app/api/_utils.js|getOrderListRevision|partial-failure-predicate-abort", new Set(["c2536c54489630299f38"])],
  ["app/api/_utils.js|getOrderSummariesPageFast|partial-failure-predicate-abort", new Set([
    "24a1706eb16696c04779", "38f6a1e5feaa52374ea7",
  ])],
  ["app/api/_utils.js|getOrderSummariesPageFast|partial-failure-silent-filter", new Set(["7ed34f850bd532672d67"])],
  ["app/api/_utils.js|listAllUserEmailsStrict|partial-failure-predicate-abort", new Set(["9111a4713ca49fda37b8"])],
  ["app/api/_utils.js|redeemGuardPipelineRows|partial-failure-predicate-abort", new Set(["3233bc669a4945fa0f2f"])],
  ["app/api/_utils.js|settleOrderReferralCommission|partial-failure-every-empty", new Set(["6aa3e88c970b19402cbb"])],
  ["app/api/_utils.js|listWithdrawals|partial-failure-predicate-abort", new Set(["65a64a7bed77d1d730bd"])],
  ["app/api/admin/after-sales/notify-by-reference/route.js|overlayCurrentOrderCredentials|partial-failure-predicate-abort", new Set(["7246fde1fe3bd014e717"])],
  ["app/api/admin/mail/audience-data.js|buildMailAudience|partial-failure-predicate-abort", new Set(["bfabd46a0af6239a6fb4"])],
  ["app/api/admin/mail/marketing-data.js|strictCatalogOverrides|partial-failure-predicate-abort", new Set(["5cffaac5dbe9de384a3c"])],
  ["app/api/admin/mail/marketing-data.js|strictCatalogStockMap|partial-failure-predicate-abort", new Set(["80d58a48710bcb042384"])],
  ["app/api/admin/mail/marketing-data.js|strictCatalogStockMap|partial-failure-loop-throw", new Set(["90bb8b56c26a0f8c9ea5"])],
  ["app/api/admin/mail/marketing-data.js|buildMarketingArgs|partial-failure-predicate-abort", new Set(["c3033f37fd8aa52f6c74"])],
  ["app/api/admin/insights/route.js|strictRedisValues|partial-failure-predicate-abort", new Set(["17ea055fc7a9a097463e"])],
  ["app/api/admin/insights/route.js|GET|partial-failure-predicate-abort", new Set(["c74d2aa1c235645e86e8"])],
  ["app/api/admin/netflix-code/route.js|netflixOrdersFromDirectory|partial-failure-silent-filter", new Set(["c17ae63248cd09d68792"])],
  ["app/api/admin/netflix-code/route.js|GET|partial-failure-silent-continue", new Set(["94edbe655d07428e2a36"])],
  ["app/api/admin/overview/route.js|GET|partial-failure-silent-continue", new Set(["2f83dd9e0ed715275d5b", "b769f7b2e7c9e5b3f6a3"])],
  ["app/api/after-sales/_store.js|getActiveAfterSalesTickets|partial-failure-silent-filter", new Set(["41faa9fa85e78497af12"])],
  ["app/api/netflix-code/_store.js|storeNetflixMailEvent|partial-failure-silent-filter", new Set(["519e1158edb7a62b11ca"])],
  ["app/lib/admin-mutation-journal.js|persistExactRecord|partial-failure-predicate-abort", new Set(["4868fd1bf9b4e5566162"])],
  ["app/lib/checkout-pending-journal.js|writeCheckoutPendingJournal|partial-failure-predicate-abort", new Set(["37b6e8d2f7797ef70081"])],
  ["app/lib/store.js|getCatalogProducts|partial-failure-silent-filter", new Set(["71cc6fae993d32e668a5"])],
  ["app/page.jsx|Page|partial-failure-silent-filter", new Set(["1ffab51f586275ed242c"])],
]);

const functionTypes = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
  "ObjectMethod", "ClassMethod",
]);
const loopTypes = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);

function propertyName(member) {
  if (!member || member.type !== "MemberExpression") return "";
  if (!member.computed && member.property?.type === "Identifier") return member.property.name;
  if (member.property?.type === "StringLiteral") return member.property.value;
  return "";
}

function callMethod(node, name) {
  return node?.type === "CallExpression" && propertyName(node.callee) === name;
}

function functionLabel(ancestors, source) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index];
    if (!functionTypes.has(node.type)) continue;
    if (node.id?.name) return node.id.name;
    const owner = ancestors[index - 1];
    if (owner?.type === "VariableDeclarator" && owner.id?.type === "Identifier") return owner.id.name;
    if (["ObjectProperty", "ObjectMethod", "ClassMethod"].includes(owner?.type)) {
      return owner.key?.name || owner.key?.value || "<method>";
    }
    const compact = nodeText(source, node).slice(0, 70).replace(/\s+/g, " ");
    return compact || "<anonymous>";
  }
  return "<module>";
}

function enclosingFunction(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    if (functionTypes.has(ancestors[index]?.type)) return ancestors[index];
  }
  return null;
}

function subtreeHas(node, predicate, { skipNestedFunctions = false } = {}) {
  let matched = false;
  function walk(candidate, rootNode) {
    if (matched || !candidate || typeof candidate !== "object") return;
    if (candidate !== rootNode && skipNestedFunctions && functionTypes.has(candidate.type)) return;
    if (typeof candidate.type === "string" && predicate(candidate)) {
      matched = true;
      return;
    }
    for (const [key, value] of Object.entries(candidate)) {
      if (["loc", "start", "end", "extra", "comments", "tokens", "errors"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((child) => walk(child, rootNode));
      else walk(value, rootNode);
    }
  }
  walk(node, node);
  return matched;
}

function emptyResult(node) {
  return node?.type === "NullLiteral"
    || (node?.type === "ArrayExpression" && node.elements.length === 0)
    || (node?.type === "ObjectExpression" && node.properties.length === 0);
}

function emptyCollection(node) {
  return (node?.type === "ArrayExpression" && node.elements.length === 0)
    || (node?.type === "ObjectExpression" && node.properties.length === 0);
}

function failureOutcome(node) {
  return subtreeHas(node, (candidate) => (
    candidate.type === "ThrowStatement"
    || (candidate.type === "ReturnStatement" && emptyResult(candidate.argument))
  ), { skipNestedFunctions: true });
}

function collectionPredicate(node) {
  return subtreeHas(node, (candidate) => callMethod(candidate, "some") || callMethod(candidate, "every"));
}

function validationLike(node, source) {
  return /(?:invalid|valid[A-Z_]|corrupt|malform|parse|record|payload|entry|row|error|null|undefined|length\s*[!=]==?)/i
    .test(nodeText(source, node));
}

function pipelineTransportPredicate(node, ancestors, source) {
  const text = nodeText(source, node);
  if (!/(?:\.error\b|["']error["'])/.test(text)) return false;
  const owner = enclosingFunction(ancestors);
  const ownerText = owner ? nodeText(source, owner) : text;
  return /Array\.isArray\s*\(/.test(ownerText) && /\.length\b/.test(ownerText);
}

function directMapForBooleanFilter(node) {
  if (!callMethod(node, "filter") || node.arguments?.[0]?.type !== "Identifier" || node.arguments[0].name !== "Boolean") return null;
  let receiver = node.callee.object;
  while (["AwaitExpression", "ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression"].includes(receiver?.type)) {
    receiver = receiver.expression || receiver.argument;
  }
  if (callMethod(receiver, "map")) return receiver;
  // `(await Promise.all(ids.map(load))).filter(Boolean)` is the same silent
  // projection with an asynchronous mapper.
  let nested = null;
  if (receiver?.type === "CallExpression") {
    for (const argument of receiver.arguments || []) {
      if (callMethod(argument, "map")) { nested = argument; break; }
    }
  }
  return nested;
}

function mapperMayDropBusinessRecord(mapCall, source) {
  const mapper = mapCall?.arguments?.[0];
  if (!mapper) return false;
  const text = nodeText(source, mapper);
  if (mapper.type === "Identifier") {
    return /(?:parse|record|order|user|visitor|snapshot|directory|event|recipient|account|ticket|campaign|delivery|normalize.*(?:id|email)|safe.*id)/i.test(mapper.name);
  }
  return /(?:JSON\.parse|parse[A-Z_(]|normalize[A-Z_].*(?:id|email)|safe[A-Z_].*id|return\s+null|catch\s*\(|\?\s*null\s*:|:\s*null\b)/i.test(text);
}

function keyFor(file, label, rule) {
  return `${path.relative(root, file).replaceAll("\\", "/")}|${label}|${rule}`;
}

function normalizedNodeSource(source, node) {
  return nodeText(source, node)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\r\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function nodeFingerprint(source, node) {
  return createHash("sha256").update(normalizedNodeSource(source, node)).digest("hex").slice(0, 20);
}

function hasAdjacentSafetyComment(source, node, rule) {
  const before = source.slice(0, Number(node?.start || 0));
  const lines = before.split(/\r?\n/);
  const previous = lines.slice(Math.max(0, lines.length - 2)).join("\n");
  const escapedRule = rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`audit-partial-failure:\\s*allow\\s+${escapedRule}\\s+--\\s+\\S.{7,}`, "i").test(previous);
}

function report(file, node, source, ancestors, rule, message) {
  const label = functionLabel(ancestors, source);
  const key = keyFor(file, label, rule);
  const fingerprint = nodeFingerprint(source, node);
  const classification = ALLOW_CLASSIFICATIONS.get(key);
  if (process.env.AUDIT_PARTIAL_CAPTURE_ALLOW === "1" && classification) {
    process.stderr.write(`${JSON.stringify([key, fingerprint, classification])},\n`);
  }
  if (hasAdjacentSafetyComment(source, node, rule)
      || ALLOW_FINGERPRINTS.get(key)?.has?.(fingerprint)
      || ALLOW_FINGERPRINTS.get(key)?.includes?.(fingerprint)) return;
  findings.push(finding(root, file, node, rule, `${message}（函数 ${label}）`));
}

function enclosingFunctionLogsSkipped(ancestors, source) {
  const owner = enclosingFunction(ancestors);
  if (!owner) return false;
  const text = nodeText(source, owner);
  return /console\.(?:warn|error)\s*\(/.test(text)
      && /(?:skip|ignored|corrupt|invalid|malformed|unreadable|丢弃|忽略)/i.test(text)
    || /warnSkippedRecords\s*\(/.test(text);
}

function enclosingFunctionHandlesPartial(ancestors, source) {
  const owner = enclosingFunction(ancestors);
  if (!owner) return false;
  const text = nodeText(source, owner);
  return enclosingFunctionLogsSkipped(ancestors, source)
    || (/diagnostics\.push\s*\(/.test(text) && /corrupt/i.test(text))
    || (/corruptCount/.test(text) && /catch\s*\(/.test(text));
}

// A warning only proves tolerance when it is emitted by the same callback or
// loop that drops the member.  An unrelated warning elsewhere in the function
// must not suppress a finding.
function nodeLogsItsOwnSkip(node, ancestors, source) {
  if (!node) return false;
  const text = nodeText(source, node);
  if (/(?:console\.(?:warn|error)|warnSkippedRecords|diagnostics\.push)\s*\(/.test(text)
      && /(?:skip|ignored|corrupt|invalid|malformed|unreadable|dropped|丢弃|忽略)/i.test(text)) return true;
  const owner = enclosingFunction(ancestors);
  if (!owner || Number(node.end) >= Number(owner.end)) return false;
  const counters = [...text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)]
    .map((match) => match[1])
    .filter((name) => /(?:skip|corrupt|invalid|missing|drop)/i.test(name));
  if (!counters.length) return false;
  const after = source.slice(Number(node.end), Number(owner.end));
  return counters.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:console\\.(?:warn|error)|warnSkippedRecords|diagnostics\\.push)\\s*\\([\\s\\S]{0,500}\\b${escaped}\\b`).test(after);
  });
}

function collectLocalFunctions(ast) {
  const functions = new Map();
  visit(ast, (node, ancestors) => {
    if (node.type === "FunctionDeclaration" && node.id?.name) functions.set(node.id.name, node);
    if (["FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      const owner = ancestors.at(-1);
      if (owner?.type === "VariableDeclarator" && owner.id?.type === "Identifier") functions.set(owner.id.name, node);
    }
  });
  return functions;
}

function mapperCallsThrowingHelper(mapper, functions) {
  let risky = false;
  if (!mapper) return false;
  const names = new Set();
  if (mapper.type === "Identifier") names.add(mapper.name);
  visit(mapper, (candidate) => {
    if (candidate.type === "CallExpression" && candidate.callee?.type === "Identifier") names.add(candidate.callee.name);
  });
  for (const name of names) {
    const definition = functions.get(name);
    if (definition && subtreeHas(definition, (candidate) => candidate.type === "ThrowStatement", { skipNestedFunctions: false })) {
      risky = true;
      break;
    }
  }
  return risky;
}

function isApiReadContext(file, ancestors, source) {
  const relativeFile = path.relative(root, file).replaceAll("\\", "/");
  return relativeFile.startsWith("app/api/")
    && /^(?:GET|get|list|read|load|recordsFromIndex|usersByEmail|.*backfill)/i.test(functionLabel(ancestors, source));
}

function enclosingStatement(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index];
    if (/Statement$/.test(node?.type || "") || node?.type === "VariableDeclaration") return node;
  }
  return null;
}

function enclosingBlock(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    if (ancestors[index]?.type === "BlockStatement") return ancestors[index];
  }
  return null;
}

function awaitedRedisPipeline(node) {
  if (node?.type !== "AwaitExpression" || node.argument?.type !== "CallExpression") return false;
  const callee = node.argument.callee;
  return (callee?.type === "Identifier" && /^(?:redisPipeline|pipeline)$/i.test(callee.name))
    || (callee?.type === "MemberExpression" && /pipeline/i.test(propertyName(callee)));
}

function declaratorNameForAwait(node, ancestors) {
  const parent = ancestors.at(-1);
  return parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier" ? parent.id.name : "";
}

function pipelineChecks(ownerText, variable) {
  const names = new Set([variable]);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const name of [...names]) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const aliasPattern = new RegExp(`\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=([^;\\n]*\\b${escaped}\\b[^;\\n]*)`, "g");
      for (const match of ownerText.matchAll(aliasPattern)) names.add(match[1]);
    }
  }
  let shape = false;
  let errors = false;
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const checkedByHelper = new RegExp(`(?:strict|checked|validate|writeSucceeded|pipelineSucceeded)[A-Za-z0-9_]*\\s*\\([^)]*\\b${escaped}\\b`).test(ownerText);
    const normalizedByHelper = new RegExp(`\\b${escaped}\\s*=\\s*(?:pipelineResults?|pipelineRows)\\s*\\(`).test(ownerText);
    shape ||= checkedByHelper || ((new RegExp(`Array\\.isArray\\s*\\(\\s*${escaped}\\s*\\)`).test(ownerText)
      || normalizedByHelper)
      && new RegExp(`\\b${escaped}\\s*\\.\\s*length\\b`).test(ownerText));
    errors ||= checkedByHelper
      || new RegExp(`(?:redisResponseError|pipelineEntryError|hasRedisError|strictPipelineRows?)\\s*\\([^)]*\\b${escaped}\\b`).test(ownerText)
      || new RegExp(`\\b${escaped}\\s*\\.(?:some|every|map|forEach|findIndex|slice)\\s*\\([\\s\\S]{0,240}?(?:HasError|\\.error\\b|["']error["'])`).test(ownerText)
      || new RegExp(`\\b${escaped}\\s*\\[[^\\]]+\\]\\s*\\?*\\.\\s*error\\b`).test(ownerText);
  }
  return { shape, errors };
}

function paginationFailureStillCompletes(node, ancestors, source) {
  if (!loopTypes.has(node.type)) return false;
  const loopText = nodeText(source, node);
  if (!/(?:cursor|page|offset|batch)/i.test(loopText) || !/\bawait\b/.test(loopText)) return false;
  const suppressesFailure = subtreeHas(node.body, (candidate) => {
    if (candidate.type !== "CatchClause") return false;
    return !subtreeHas(candidate.body, (child) => child.type === "ThrowStatement", { skipNestedFunctions: true });
  }, { skipNestedFunctions: true });
  if (!suppressesFailure) return false;
  const block = enclosingBlock(ancestors);
  const position = block?.body?.indexOf(node);
  if (position == null || position < 0) return false;
  return block.body.slice(position + 1).some((candidate) => {
    const text = nodeText(source, candidate);
    return /(?:complete|completed|done|marker|backfill)/i.test(text)
      && /(?:redisCmd|redisPipeline|\.set\s*\()/.test(text)
      && /["']SET["']|\.set\s*\(/i.test(text);
  });
}

function looksLikeFixedWindowStarvation(owner, source) {
  if (!owner) return false;
  const text = nodeText(source, owner);
  const fixedWindow = /["'](?:LRANGE|ZRANGE)["'][\s\S]{0,180}?["']0["'][\s\S]{0,180}?(?:limit\s*-\s*1|String\s*\(\s*limit\s*-\s*1\s*\)|MAX_[A-Z_]+\s*-\s*1)/i.test(text);
  const canDrop = /(?:filter\s*\(\s*Boolean\s*\)|continue\s*;|return\s+null\b)/.test(text)
    && /(?:invalid|corrupt|malform|parse|unreadable|missing)/i.test(text);
  const progresses = /(?:LREM|ZREM|cursor|offset|page|while\s*\(|for\s*\([^)]*(?:cursor|offset|page))/i.test(text);
  return fixedWindow && canDrop && !progresses;
}

const files = await walkFiles(path.join(root, "app"), (file) => /\.(?:js|jsx|mjs)$/.test(file));
const fixedWindowReported = new Set();
for (const file of files) {
  const source = await sourceFile(file);
  const ast = parseModule(source, file);
  const localFunctions = collectLocalFunctions(ast);
  visit(ast, (node, ancestors) => {
    if (node.type === "ConditionalExpression" && collectionPredicate(node.test)
        && (emptyResult(node.consequent) || emptyResult(node.alternate))) {
      report(file, node, source, ancestors, "partial-failure-every-empty",
        "批量 every/some 校验失败后返回空集合，可能让一条坏数据隐藏整批记录");
    }

    if (node.type === "IfStatement" && collectionPredicate(node.test)
        && validationLike({ start: node.test.start, end: node.consequent.end }, source)
        && failureOutcome(node.consequent)
        && !pipelineTransportPredicate(node.test, ancestors, source)) {
      report(file, node, source, ancestors, "partial-failure-predicate-abort",
        "批量 some/every 校验失败后中止整个读取；应确认是传输/写入校验，否则逐条跳过并告警");
    }

    if (callMethod(node, "map")) {
      const mapper = node.arguments?.[0];
      if (mapper && subtreeHas(mapper, (candidate) => candidate.type === "ThrowStatement")) {
        report(file, node, source, ancestors, "partial-failure-map-throw",
          "逐条 map 校验中抛错会让单条坏记录终止整批读取");
      }
      const apiRead = isApiReadContext(file, ancestors, source);
      if (mapper && apiRead && mapperCallsThrowingHelper(mapper, localFunctions)
          && !nodeLogsItsOwnSkip(mapper, ancestors, source)) {
        report(file, node, source, ancestors, "partial-failure-map-parser-throw",
          "逐条 map 调用可抛错解析器，单条坏记录可能终止整批读取");
      }
    }

    if (callMethod(node, "forEach")) {
      const iterator = node.arguments?.[0];
      if (iterator && subtreeHas(iterator, (candidate) => candidate.type === "ThrowStatement")
          && !nodeLogsItsOwnSkip(iterator, ancestors, source)) {
        report(file, node, source, ancestors, "partial-failure-loop-throw",
          "逐条 forEach 校验中抛错会让单条坏记录终止整批读取");
      }
    }

    if (node.type === "ForOfStatement"
        && validationLike(node.body, source)
        && subtreeHas(node.body, (candidate) => candidate.type === "ThrowStatement", { skipNestedFunctions: true })
        && !nodeLogsItsOwnSkip(node.body, ancestors, source)) {
      report(file, node, source, ancestors, "partial-failure-loop-throw",
          "逐条 for-of 校验中抛错会让单条坏记录终止整批读取");
    }

    if (node.type === "ForOfStatement" && isApiReadContext(file, ancestors, source)
        && !nodeLogsItsOwnSkip(node.body, ancestors, source)
        && subtreeHas(node.body, (candidate) => (
          candidate.type === "IfStatement"
          && validationLike(candidate.test, source)
          && subtreeHas(candidate.consequent, (child) => child.type === "ContinueStatement", { skipNestedFunctions: true })
        ), { skipNestedFunctions: true })) {
      report(file, node, source, ancestors, "partial-failure-silent-continue",
        "逐条读取遇到不合格记录后 continue，但未记录被跳过的数量或原因");
    }

    const mapCall = directMapForBooleanFilter(node);
    if (mapCall && mapperMayDropBusinessRecord(mapCall, source) && !nodeLogsItsOwnSkip(mapCall.arguments?.[0], ancestors, source)) {
      report(file, node, source, ancestors, "partial-failure-silent-filter",
        "业务记录转换后 filter(Boolean) 静默丢弃；需记录丢弃数量和原因，或注明仅为空值清理");
    }

    const loopText = loopTypes.has(node.type) ? nodeText(source, node) : "";
    if (loopTypes.has(node.type) && /\bawait\b/.test(loopText)
        && /(?:cursor|page|offset|batch)/i.test(loopText)
        && subtreeHas(node.body, (candidate) => (
          candidate.type === "ReturnStatement" && emptyCollection(candidate.argument)
        ), { skipNestedFunctions: true })) {
      report(file, node, source, ancestors, "partial-failure-page-reset",
        "循环/分页读取中返回空集合可能丢弃之前已读取的页面");
    }

    if (awaitedRedisPipeline(node) && isApiReadContext(file, ancestors, source)) {
      const variable = declaratorNameForAwait(node, ancestors);
      const owner = enclosingFunction(ancestors);
      if (variable && owner) {
        const checks = pipelineChecks(nodeText(source, owner), variable);
        if (!checks.shape) {
          report(file, node, source, ancestors, "partial-failure-pipeline-shape",
            "读取管道结果未同时校验数组形态与返回项数量，截断响应可能被当作完整批次");
        }
        if (!checks.errors) {
          report(file, node, source, ancestors, "partial-failure-pipeline-errors",
            "读取管道结果未逐项检查 Redis error，单个命令失败可能被误当作坏记录或空值");
        }
      }
    }

    if (paginationFailureStillCompletes(node, ancestors, source)) {
      report(file, node, source, ancestors, "partial-failure-backfill-completion",
        "分页读取吞掉失败后仍写完成标记，可能永久遗漏尚未读取的数据页");
    }

    const owner = enclosingFunction(ancestors);
    if (owner && node === owner.body && looksLikeFixedWindowStarvation(owner, source)) {
      const ownerKey = `${file}:${owner.start}`;
      if (!fixedWindowReported.has(ownerKey)) {
        fixedWindowReported.add(ownerKey);
        report(file, owner, source, ancestors, "partial-failure-fixed-window-starvation",
          "固定窗口读取会跳过坏记录但不清理或继续翻页，窗口后的有效记录可能长期饥饿");
      }
    }
  });
}

finish(findings);
