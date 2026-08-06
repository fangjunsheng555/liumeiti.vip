import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/admin/SystemHealthPanel.jsx", import.meta.url), "utf8");

test("system health refresh control is styled and exposes loading state", () => {
  assert.match(source, /className="health-head-actions"/);
  assert.match(source, /\.health-head-actions button\s*\{[^}]*display:\s*inline-flex/);
  assert.match(source, /\.health-head-actions button:disabled\s*\{[^}]*cursor:\s*wait/);
  assert.match(source, /disabled=\{loading\}/);
});

test("system health requests time out instead of leaving refresh disabled forever", () => {
  assert.match(source, /const REQUEST_TIMEOUT_MS = 15_000/);
  assert.match(source, /window\.setTimeout\(\(\) => \{\s*timedOut = true;\s*controller\.abort\(\);/);
  assert.match(source, /if \(timedOut\) throw new Error\("request_timeout"\)/);
  assert.match(source, /window\.clearTimeout\(timeout\)/);
});

test("the latest quiet refresh can clear a spinner inherited from an aborted visible load", () => {
  assert.match(source, /if \(sequence === loadSequence\.current\) setLoading\(false\)/);
  assert.doesNotMatch(source, /if \(!quiet && sequence === loadSequence\.current\) setLoading\(false\)/);
});

test("system health errors are announced and mobile trace rows stack instead of overflowing", () => {
  assert.match(source, /className="admin-inline-error" role="alert"/);
  assert.match(source, /className="health-trace-error" role="alert"/);
  assert.match(source, /\.health-trace-event\s*\{\s*grid-template-columns:\s*auto minmax\(0, 1fr\);\s*align-items:\s*start/);
  assert.match(source, /\.health-trace-event > span:nth-of-type\(n\+2\), \.health-trace-event > code\s*\{\s*grid-column:\s*2/);
});

test("corrupt health history is visibly reported without hiding valid component status", () => {
  assert.match(source, /historyDiagnostics:\s*\[\]/);
  assert.match(source, /Array\.isArray\(health\.historyDiagnostics\)/);
  assert.match(source, /className="health-note health-history-warning" role="status"/);
  assert.match(source, /健康历史数据已降级/);
  assert.match(source, /无法解析的旧记录，已跳过；当前组件状态仍独立读取/);
});

test("health navigation exposes its current section and full trace ids remain readable", () => {
  assert.match(source, /aria-current=\{tab === key \? "page" : undefined\}/);
  assert.match(source, /\.health-trace-ids code\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/);
  assert.match(source, /\.health-trace-event > code\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/);
  assert.match(source, /<code title=\{traceData\.businessTraceId \|\| ""\}>/);
});

test("styles emitted by child chart and badge components cross the styled-jsx boundary", () => {
  assert.match(source, /:global\(\.health-chart\)/);
  assert.match(source, /:global\(\.health-chart polyline\)/);
  assert.match(source, /:global\(\.health-badge\)/);
  assert.match(source, /:global\(\.health-badge\.error\)/);
});

test("system health explains the Hobby-compatible hourly scheduler without a stale five-minute claim", () => {
  assert.match(source, /GitHub 每小时巡检（Hobby 兼容）/);
  assert.match(source, /schedulerCadenceMs/);
  assert.match(source, /schedulerMissedAfterMs/);
  assert.match(source, /Math\.round\(ms \/ 360_000\) \/ 10/);
  assert.doesNotMatch(source, /5 分钟心跳判断漏跑|开启 5 分钟漏跑阈值/);
});

test("system health presents allowlisted core API metrics instead of implying whole-site coverage", () => {
  assert.match(source, /核心 API 趋势/);
  assert.match(source, /核心 API 5xx/);
  assert.match(source, /核心 API P95/);
  assert.match(source, /核心 API 服务端错误率/);
  assert.match(source, /白名单口径/);
  assert.match(source, /其他接口不会进入本页请求量、错误率或 P95/);
  assert.match(source, /metricCoverage\.routeCount/);
  assert.match(source, /metricCoverage\.groupCount/);
  assert.match(source, /metricCoverageLabels\.join\("、"\)/);
  assert.doesNotMatch(source, />API 5xx</);
  assert.doesNotMatch(source, />API P95</);
  assert.doesNotMatch(source, />服务端错误率</);
});
