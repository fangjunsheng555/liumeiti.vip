"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Clock3,
  Database,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  UserCheck,
  Workflow,
} from "lucide-react";

const STATUS = {
  ok: { label: "正常", tone: "ok" },
  success: { label: "成功", tone: "ok" },
  warning: { label: "待确认", tone: "warn" },
  running: { label: "运行中", tone: "warn" },
  never: { label: "未运行", tone: "warn" },
  unknown: { label: "待采样", tone: "neutral" },
  error: { label: "异常", tone: "error" },
  failed: { label: "失败", tone: "error" },
  disabled: { label: "未启用", tone: "neutral" },
};

const INCIDENT_STATUS = {
  open: "待确认",
  reopened: "再次发生",
  acknowledged: "处理中",
  investigating: "调查中",
  recovered: "已恢复待关闭",
  resolved: "已关闭",
};

const EMPTY_DATA = {
  health: { components: [], counts: {}, history: {}, generatedAt: "" },
  metrics: { points: [], summary: {}, coverage: null },
  jobs: { jobs: [], highFrequencyMode: false },
  queues: { queues: [] },
  incidents: { incidents: [], counts: {}, owners: [], total: 0 },
};

const SECTION_LABELS = {
  health: "组件概览",
  metrics: "核心 API 趋势",
  jobs: "任务历史",
  queues: "队列状态",
  incidents: "事故中心",
};

function compactTime(value) {
  if (!value) return "尚无记录";
  const text = String(value);
  const beijing = text.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (beijing) return `${beijing[1].slice(5)} ${beijing[2]}`;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDuration(value) {
  const ms = Math.max(0, Number(value || 0));
  if (!ms) return "0 秒";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  if (ms < 86_400_000) return `${Math.round(ms / 360_000) / 10} 小时`;
  return `${Math.round(ms / 86_400_000)} 天`;
}

function formatPercent(value) {
  const percentage = Math.max(0, Number(value || 0)) * 100;
  return `${percentage < 0.1 && percentage > 0 ? percentage.toFixed(2) : percentage.toFixed(1)}%`;
}

function metricText(metrics) {
  return Object.entries(metrics || {}).slice(0, 4).map(([key, value]) => `${key} ${value}`);
}

const REQUEST_TIMEOUT_MS = 15_000;

async function requestJson(url, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `http_${response.status}`);
    return payload;
  } catch (error) {
    if (timedOut) throw new Error("request_timeout");
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function Sparkline({ points, field, color, formatValue }) {
  const rows = Array.isArray(points) ? points : [];
  const values = rows.map((item) => Math.max(0, Number(item?.[field] || 0)));
  const hasSamples = rows.some((item) => Number(item?.requests || 0) > 0);
  if (!hasSamples) return <div className="health-chart-empty">该时段暂无核心 API 样本</div>;
  const width = 720;
  const height = 150;
  const ceiling = Math.max(1, ...values);
  const coordinates = values.map((value, index) => {
    const x = values.length <= 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - 12 - (value / ceiling) * (height - 24);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const latest = [...rows].reverse().find((item) => Number(item?.requests || 0) > 0)?.[field] || 0;
  return (
    <div className="health-chart">
      <div className="health-chart-value">最近采样 <strong>{formatValue(latest)}</strong><span>峰值 {formatValue(ceiling)}</span></div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${field} 趋势`} preserveAspectRatio="none">
        <line x1="0" x2={width} y1="12" y2="12" />
        <line x1="0" x2={width} y1={height / 2} y2={height / 2} />
        <line x1="0" x2={width} y1={height - 12} y2={height - 12} />
        <polyline points={coordinates} style={{ stroke: color }} />
      </svg>
      <div className="health-chart-axis"><span>{compactTime(rows[0]?.at)}</span><span>{compactTime(rows.at(-1)?.at)}</span></div>
    </div>
  );
}

function StateBadge({ status, missed = false }) {
  const meta = missed ? { label: "可能漏跑", tone: "error" } : (STATUS[status] || STATUS.warning);
  return <span className={`health-badge ${meta.tone}`}><i />{meta.label}</span>;
}

export default function SystemHealthPanel() {
  const [data, setData] = useState(EMPTY_DATA);
  const [tab, setTab] = useState("overview");
  const [range, setRange] = useState("24h");
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState("");
  const [message, setMessage] = useState("");
  const [traceQuery, setTraceQuery] = useState("");
  const [traceData, setTraceData] = useState(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState("");
  const [sectionErrors, setSectionErrors] = useState({});
  const loadSequence = useRef(0);
  const loadController = useRef(null);
  const traceSequence = useRef(0);
  const traceController = useRef(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    const sequence = loadSequence.current + 1;
    loadSequence.current = sequence;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    if (!quiet) setLoading(true);
    try {
      const requests = [
        ["health", "/api/admin/health"],
        ["metrics", `/api/admin/health/metrics?range=${encodeURIComponent(range)}`],
        ["jobs", "/api/admin/health/jobs"],
        ["queues", "/api/admin/health/queues"],
        ["incidents", "/api/admin/health/incidents?limit=50"],
      ];
      const settled = await Promise.allSettled(requests.map(([, url]) => requestJson(url, { signal: controller.signal })));
      if (sequence !== loadSequence.current) return;
      const errors = {};
      const updates = {};
      settled.forEach((result, index) => {
        const key = requests[index][0];
        if (result.status === "fulfilled") updates[key] = result.value;
        else if (result.reason?.name !== "AbortError") errors[key] = result.reason?.message || "unknown";
      });
      setData((previous) => ({ ...previous, ...updates }));
      setSectionErrors(errors);
      const unauthorized = Object.values(errors).includes("unauthorized");
      setMessage(unauthorized ? "仅超级管理员可查看系统健康状态" : "");
    } catch (error) {
      if (error?.name !== "AbortError" && sequence === loadSequence.current) {
        setMessage(error?.message === "unauthorized" ? "仅超级管理员可查看系统健康状态" : `系统状态加载失败：${error?.message || "unknown"}`);
      }
    } finally {
      // A quiet interval refresh may supersede the visible initial load. The
      // latest request always owns the spinner, regardless of how it started.
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load({ quiet: true }), 30_000);
    return () => {
      window.clearInterval(timer);
      loadController.current?.abort();
      traceController.current?.abort();
    };
  }, [load]);

  const mutateIncident = useCallback(async (incident, input) => {
    const action = input.action;
    const key = `${incident.id}:${action}`;
    setActing(key);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/health/incidents/${encodeURIComponent(incident.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
        },
        body: JSON.stringify({ ...input, expectedVersion: incident.version }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || `http_${response.status}`);
      await load({ quiet: true });
    } catch (error) {
      const errors = {
        stale_version: "事故已被其他管理员更新，列表已刷新",
        resolution_required: "请填写不少于 3 个字的处理结论",
        invalid_incident_transition: "当前事故状态不允许执行该操作",
      };
      setMessage(errors[error?.message] || `事故更新失败：${error?.message || "unknown"}`);
      if (error?.message === "stale_version") await load({ quiet: true });
    } finally {
      setActing("");
    }
  }, [load]);

  const resolveIncident = (incident) => {
    const resolution = window.prompt("请输入事故原因、修复动作或验证结论（至少 3 个字）", incident.resolution || "");
    if (resolution == null) return;
    mutateIncident(incident, { action: "resolve", resolution });
  };

  const searchTrace = async (event) => {
    event.preventDefault();
    const orderId = traceQuery.trim();
    if (!orderId) return;
    const sequence = traceSequence.current + 1;
    traceSequence.current = sequence;
    traceController.current?.abort();
    const controller = new AbortController();
    traceController.current = controller;
    setTraceLoading(true);
    setTraceError("");
    try {
      const trace = await requestJson(`/api/admin/health/traces/${encodeURIComponent(orderId)}`, { signal: controller.signal });
      if (sequence !== traceSequence.current) return;
      setTraceData(trace);
    } catch (error) {
      if (error?.name === "AbortError" || sequence !== traceSequence.current) return;
      setTraceData(null);
      setTraceError(error?.message === "order_not_found" ? "未找到该订单" : `Trace 查询失败：${error?.message || "unknown"}`);
    } finally {
      if (sequence === traceSequence.current) setTraceLoading(false);
    }
  };

  const health = data.health;
  const summary = data.metrics.summary || {};
  const metricCoverage = data.metrics.coverage || {};
  const metricCoverageGroups = Array.isArray(metricCoverage.groups) ? metricCoverage.groups : [];
  const metricCoverageLabels = metricCoverageGroups.map((item) => item.label || item.name).filter(Boolean);
  const incidents = data.incidents.incidents || [];
  const queues = data.queues.queues || [];
  const openIncidentCount = incidents.filter((item) => item.status !== "resolved").length;
  const backlog = queues.reduce((sum, item) => sum + Number(item.count || 0), 0);
  const missedJobs = (data.jobs.jobs || []).filter((item) => item.missed).length;
  const externalHourlyScheduler = data.jobs.schedulerMode
    ? data.jobs.schedulerMode === "external_hourly"
    : data.jobs.highFrequencyMode;
  const schedulerCadenceMs = Number(data.jobs.schedulerCadenceMs
    || (externalHourlyScheduler ? 60 * 60_000 : 24 * 60 * 60_000));
  const schedulerMissedAfterMs = Number(data.jobs.schedulerMissedAfterMs
    || (externalHourlyScheduler ? 150 * 60_000 : 30 * 60 * 60_000));
  const healthLabels = new Map(health.components.map((item) => [item.component, item.label]));
  const recentHealthEvents = Object.entries(health.history || {})
    .flatMap(([component, events]) => (Array.isArray(events) ? events : []).map((event) => ({ ...event, component })))
    .sort((a, b) => Date.parse(b.checkedAt || "") - Date.parse(a.checkedAt || ""))
    .slice(0, 12);

  return (
    <div className="admin-compact-page health-workbench">
      <header className="admin-compact-head">
        <div>
          <h2><Activity size={18} />系统健康</h2>
          <p>核心 API 趋势、定时任务、恢复队列与事故处置</p>
        </div>
        <div className="health-head-actions">
          <small>{health.generatedAt ? `更新于 ${compactTime(health.generatedAt)}` : "等待首次采集"}</small>
          <button type="button" onClick={() => load()} disabled={loading}><RefreshCw size={14} className={loading ? "spin-icon" : ""} />刷新</button>
        </div>
      </header>

      <div className="health-kpis" aria-label="系统健康概览">
        <article><Server size={16} /><span>异常组件<small>共 {health.components.length} 项</small></span><strong className={health.counts?.error ? "danger" : "good"}>{Number(health.counts?.error || 0)}</strong></article>
        <article><Activity size={16} /><span>核心 API 5xx<small>{Number(summary.requests || 0).toLocaleString()} 次白名单请求</small></span><strong className={summary.errorRate >= 0.02 ? "danger" : "good"}>{formatPercent(summary.errorRate)}</strong></article>
        <article><Clock3 size={16} /><span>核心 API P95<small>所选统计区间</small></span><strong className={summary.p95Ms > 1500 ? "danger" : ""}>{Math.round(Number(summary.p95Ms || 0))} ms</strong></article>
        <article><ShieldAlert size={16} /><span>未关闭事故<small>{missedJobs} 个任务可能漏跑</small></span><strong className={openIncidentCount ? "danger" : "good"}>{openIncidentCount}</strong></article>
        <article><Database size={16} /><span>队列积压<small>{queues.filter((item) => ["warning", "error"].includes(item.status)).length} 个队列需关注</small></span><strong className={backlog ? "" : "good"}>{backlog}</strong></article>
      </div>

      <div className="health-toolbar">
        <nav aria-label="健康页分类">
          {[
            ["overview", "组件概览"],
            ["api", "核心 API 趋势"],
            ["jobs", "任务与队列"],
            ["incidents", `事故处置${openIncidentCount ? ` ${openIncidentCount}` : ""}`],
            ["trace", "订单 Trace"],
          ].map(([key, label]) => <button type="button" key={key} className={tab === key ? "active" : ""} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}>{label}</button>)}
        </nav>
        {tab === "api" && (
          <select value={range} onChange={(event) => setRange(event.target.value)} aria-label="趋势区间">
            <option value="1h">最近 1 小时</option>
            <option value="24h">最近 24 小时</option>
            <option value="7d">最近 7 天</option>
            <option value="30d">最近 30 天</option>
          </select>
        )}
      </div>

      {message && <div className="admin-inline-error" role="alert"><AlertTriangle size={14} />{message}</div>}
      {!!Object.keys(sectionErrors).length && (
        <div className="health-section-errors" role="status">
          {Object.entries(sectionErrors).map(([section, error]) => (
            <div className="admin-inline-error" key={section}>
              <AlertTriangle size={14} />{SECTION_LABELS[section] || section}暂时不可用：{error}
            </div>
          ))}
        </div>
      )}

      {tab === "overview" && (
        <section className="health-section">
          <div className="health-note">
            <BellRing size={16} />
            <span>
              <strong>{externalHourlyScheduler ? "GitHub 每小时巡检（Hobby 兼容）" : "Vercel Hobby 每日基线巡检"}</strong>
              <small>目标 {formatDuration(schedulerCadenceMs)} · 超过 {formatDuration(schedulerMissedAfterMs)}未运行告警 · {externalHourlyScheduler ? "Vercel 每日兜底" : "流量触发补偿"}</small>
            </span>
          </div>
          <div className="admin-health-table" aria-busy={loading}>
            <div className="admin-health-table-head"><span>服务</span><span>状态</span><span>最近检查</span><span>运行信息</span></div>
            {health.components.map((item) => {
              const meta = STATUS[item.status] || STATUS.warning;
              return (
                <div className="admin-health-row" key={item.component}>
                  <span className="admin-health-name"><i className={`admin-state-dot ${meta.tone}`} /><strong>{item.label}</strong><small>{item.summary || "--"}</small></span>
                  <span className={`admin-state-label ${meta.tone}`}>{meta.label}</span>
                  <time>{compactTime(item.checkedAtBeijing || item.lastSuccessAtBeijing)}</time>
                  <span className="admin-health-metrics">
                    {item.error ? <em>{item.error}</em> : metricText(item.metrics).map((text) => <small key={text}>{text}</small>)}
                  </span>
                </div>
              );
            })}
          </div>
          {!!recentHealthEvents.length && (
            <article className="health-panel">
              <header><span><Clock3 size={15} />Redis、邮件与服务状态历史</span><small>最近 {recentHealthEvents.length} 条</small></header>
              <div className="health-list health-history-list">
                {recentHealthEvents.map((event, index) => (
                  <div className="health-list-row" key={`${event.component}-${event.checkedAt}-${index}`}>
                    <span><strong>{healthLabels.get(event.component) || event.component}</strong><small>{event.summary || event.error || "状态更新"}</small></span>
                    <span><StateBadge status={event.status} /><small>{compactTime(event.checkedAt)}</small></span>
                  </div>
                ))}
              </div>
            </article>
          )}
        </section>
      )}

      {tab === "api" && (
        <section className="health-section health-chart-grid">
          <div className="health-note health-coverage-note">
            <ShieldAlert size={16} />
            <span>
              <strong>{metricCoverage.scopeLabel || "核心 API"}白名单口径 · {Number(metricCoverage.routeCount || 0)} 条路由 · {Number(metricCoverage.groupCount || 0)} 个业务组</strong>
              <small>
                仅汇总明确接入遥测的核心接口，其他接口不会进入本页请求量、错误率或 P95。
                {metricCoverageLabels.length ? ` 覆盖组：${metricCoverageLabels.join("、")}` : ""}
              </small>
            </span>
          </div>
          <article className="health-panel">
            <header><span><Activity size={15} />核心 API 服务端错误率</span><strong>{formatPercent(summary.errorRate)}</strong></header>
            <Sparkline points={data.metrics.points} field="errorRate" color="#d84b57" formatValue={formatPercent} />
          </article>
          <article className="health-panel">
            <header><span><Clock3 size={15} />核心 API 响应时间 P95</span><strong>{Math.round(Number(summary.p95Ms || 0))} ms</strong></header>
            <Sparkline points={data.metrics.points} field="p95Ms" color="#5268d8" formatValue={(value) => `${Math.round(Number(value || 0))} ms`} />
          </article>
          <div className="health-api-summary">
            <span><small>核心请求</small><b>{Number(summary.requests || 0).toLocaleString()}</b></span>
            <span><small>2xx</small><b>{Number(summary.status2xx || 0).toLocaleString()}</b></span>
            <span><small>4xx</small><b>{Number(summary.status4xx || 0).toLocaleString()}</b></span>
            <span><small>5xx</small><b className={summary.status5xx ? "danger" : ""}>{Number(summary.status5xx || 0).toLocaleString()}</b></span>
            <span><small>P50</small><b>{Math.round(Number(summary.p50Ms || 0))} ms</b></span>
            <span><small>P99</small><b>{Math.round(Number(summary.p99Ms || 0))} ms</b></span>
          </div>
        </section>
      )}

      {tab === "jobs" && (
        <section className="health-section health-two-columns">
          <article className="health-panel">
            <header><span><Clock3 size={15} />定时任务历史</span><small>{missedJobs ? `${missedJobs} 个可能漏跑` : "心跳正常"}</small></header>
            <div className="health-list">
              {(data.jobs.jobs || []).map((job) => (
                <div className="health-list-row" key={job.job}>
                  <span><strong>{job.label || job.job}</strong><small>{job.errorCode || `目标 ${formatDuration(job.cadenceMs)} · 告警 ${formatDuration(job.missedAfterMs)} · 处理 ${Number(job.processed || 0)}`}</small></span>
                  <span><StateBadge status={job.status} missed={job.missed} /><small>{compactTime(job.heartbeatAt || job.finishedAt)}</small></span>
                </div>
              ))}
            </div>
            {!!data.jobs.recentRuns?.length && (
              <>
                <div className="health-run-history-title">最近运行记录</div>
                <div className="health-list health-run-history">
                  {data.jobs.recentRuns.slice(0, 10).map((run) => (
                    <div className="health-list-row" key={run.runId}>
                      <span><strong>{run.label || run.job}</strong><small>耗时 {formatDuration(run.durationMs)} · 处理 {Number(run.processed || 0)} · 失败 {Number(run.failed || 0)}</small></span>
                      <span><StateBadge status={run.status} /><small>{compactTime(run.finishedAt || run.startedAt)}</small></span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </article>
          <article className="health-panel">
            <header><span><Database size={15} />Outbox 与恢复队列</span><small>按数量和最老任务判断</small></header>
            <div className="health-list">
              {queues.map((queue) => (
                <div className="health-list-row" key={queue.name}>
                  <span><strong>{queue.label}</strong><small>到期 {Number(queue.dueCount || 0)} · 最老 {formatDuration(queue.oldestAgeMs)}</small></span>
                  <span><StateBadge status={queue.status} /><b>{Number(queue.count || 0)}</b></span>
                </div>
              ))}
            </div>
          </article>
        </section>
      )}

      {tab === "incidents" && (
        <section className="health-section">
          {!incidents.length && <div className="health-empty"><CheckCircle2 size={22} /><strong>暂无事故记录</strong><small>任务失败、漏跑和队列积压会自动在这里建单</small></div>}
          <div className="health-incident-list">
            {incidents.map((incident) => {
              const busy = acting.startsWith(`${incident.id}:`);
              return (
                <article className={`health-incident ${incident.status === "resolved" ? "resolved" : ""}`} key={incident.id}>
                  <header>
                    <span className={`health-severity ${incident.severity?.toLowerCase()}`}>{incident.severity || "P2"}</span>
                    <span><strong>{incident.title}</strong><small>{incident.id} · {incident.component} · 发生 {Number(incident.occurrences || 1)} 次</small></span>
                    <b>{INCIDENT_STATUS[incident.status] || incident.status}</b>
                  </header>
                  <div className="health-incident-detail">
                    <span><small>首次 / 最近</small>{compactTime(incident.firstSeenAt)} / {compactTime(incident.lastSeenAt)}</span>
                    <span><small>错误代码</small>{incident.lastErrorCode || "--"}</span>
                    <span><small>恢复 / 关闭</small>{compactTime(incident.recoveredAt || incident.resolvedAt)}</span>
                    {incident.businessTraceId && <span><small>业务 Trace ID</small><code title={incident.businessTraceId}>{incident.businessTraceId}</code></span>}
                  </div>
                  {incident.resolution && <div className="health-resolution"><CheckCircle2 size={14} />处理结论：{incident.resolution}</div>}
                  <footer>
                    <label><UserCheck size={14} />负责人
                      <select
                        value={Number(incident.ownerStaffId || 0)}
                        disabled={busy || incident.status === "resolved"}
                        onChange={(event) => mutateIncident(incident, { action: "assign", ownerStaffId: Number(event.target.value) })}
                      >
                        <option value={0}>未指派</option>
                        {(data.incidents.owners || []).map((owner) => <option value={owner.id} key={owner.id}>{owner.username}</option>)}
                      </select>
                    </label>
                    <span>
                      {["open", "reopened"].includes(incident.status) && <button type="button" disabled={busy} onClick={() => mutateIncident(incident, { action: "acknowledge" })}>确认并认领</button>}
                      {incident.status === "acknowledged" && <button type="button" disabled={busy} onClick={() => mutateIncident(incident, { action: "investigate" })}>开始调查</button>}
                      {incident.status !== "resolved" && <button type="button" className="primary" disabled={busy} onClick={() => resolveIncident(incident)}>填写结论并关闭</button>}
                      {incident.status === "resolved" && <button type="button" disabled={busy} onClick={() => mutateIncident(incident, { action: "reopen" })}>重新打开</button>}
                    </span>
                  </footer>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {tab === "trace" && (
        <section className="health-section">
          <article className="health-panel health-trace-panel">
            <header><span><Workflow size={15} />订单全链路查询</span><small>输入订单号查看业务 Trace 与阶段事件</small></header>
            <form className="health-trace-search" onSubmit={searchTrace}>
              <input value={traceQuery} onChange={(event) => setTraceQuery(event.target.value)} placeholder="订单号或 ord_... 业务 Trace ID" aria-label="订单号或业务 Trace ID" />
              <button type="submit" disabled={traceLoading || !traceQuery.trim()}><Search size={14} />{traceLoading ? "查询中" : "查询"}</button>
            </form>
            {traceError && <div className="health-trace-error" role="alert"><AlertTriangle size={14} />{traceError}</div>}
            {traceData && (
              <div className="health-trace-result">
                <div className="health-trace-ids">
                  <span><small>订单号</small><code>{traceData.orderId}</code></span>
                  <span><small>业务 Trace ID</small><code title={traceData.businessTraceId || ""}>{traceData.businessTraceId || "--"}</code></span>
                  <span><small>初始请求 Trace ID</small><code title={traceData.requestTraceId || traceData.initialTraceId || ""}>{traceData.requestTraceId || traceData.initialTraceId || "--"}</code></span>
                  <span><small>阶段事件</small><b>{Number(traceData.events?.length || 0)}</b></span>
                </div>
                {!traceData.events?.length && <div className="health-empty"><Workflow size={22} /><strong>该订单暂无阶段事件</strong><small>固定业务 Trace ID 已可用于日志关联；新副作用会继续追加事件</small></div>}
                {!!traceData.events?.length && (
                  <div className="health-trace-events">
                    {traceData.events.map((item, index) => (
                      <div className="health-trace-event" key={`${item.spanId || item.at}-${index}`}>
                        <StateBadge status={item.outcome === "ok" ? "ok" : item.outcome === "skipped" ? "disabled" : "error"} />
                        <span><strong>{item.stage || "unknown"}</strong><small>{item.component || "app"} · {compactTime(item.at)}</small></span>
                        <span><small>耗时</small>{formatDuration(item.durationMs)}</span>
                        <span><small>操作 / 错误</small>{[
                          item.operationId ? `操作 ${item.operationId}` : "",
                          item.errorCode ? `错误 ${item.errorCode}` : "",
                        ].filter(Boolean).join(" · ") || "--"}</span>
                        <code title={item.traceId || ""}>{item.traceId || "--"}</code>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </article>
        </section>
      )}

      <style jsx>{`
        .health-workbench { --health-border: #e6eaf0; --health-muted: #728096; --health-ink: #202b3c; }
        .health-head-actions { display: flex; align-items: center; gap: 10px; }
        .health-head-actions small { color: var(--health-muted); font-size: 10.5px; }
        .health-head-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 32px; padding: 0 12px; border: 1px solid #cfd8e3; border-radius: 7px; background: #fff; color: #1f334d; font-size: 12px; font-weight: 750; cursor: pointer; }
        .health-head-actions button:disabled { cursor: wait; opacity: .6; }
        .health-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
        .health-kpis article { min-width: 0; min-height: 70px; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 9px; padding: 12px; border: 1px solid var(--health-border); border-radius: 10px; background: #fff; }
        .health-kpis article > svg { color: #64748b; }
        .health-kpis article span { display: grid; min-width: 0; color: var(--health-ink); font-size: 11.5px; font-weight: 650; }
        .health-kpis article small { margin-top: 3px; color: var(--health-muted); font-size: 9.5px; font-weight: 450; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .health-kpis article > strong { color: var(--health-ink); font-size: 18px; letter-spacing: -.03em; }
        .good { color: #087c70 !important; } .danger { color: #c33b47 !important; }
        .health-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0 8px; border-bottom: 1px solid var(--health-border); }
        .health-toolbar nav { display: flex; gap: 2px; overflow-x: auto; }
        .health-toolbar button { position: relative; padding: 9px 12px; border: 0; background: transparent; color: #617086; font-size: 11px; white-space: nowrap; cursor: pointer; }
        .health-toolbar button.active { color: #273454; font-weight: 700; }
        .health-toolbar button.active::after { position: absolute; right: 9px; bottom: -1px; left: 9px; height: 2px; border-radius: 2px; background: #5367d5; content: ""; }
        .health-toolbar select, .health-incident select { border: 1px solid #dce2ea; border-radius: 7px; background: #fff; color: #38465b; font-size: 10.5px; }
        .health-toolbar > select { margin-bottom: 6px; padding: 5px 24px 5px 8px; }
        .health-section { display: grid; gap: 10px; }
        .health-section-errors { display: grid; gap: 6px; margin-bottom: 8px; }
        .health-note { display: flex; align-items: center; gap: 9px; padding: 10px 12px; border: 1px solid #dfe5f6; border-radius: 9px; background: #f7f8fd; color: #5367b9; }
        .health-note span { display: grid; gap: 2px; }
        .health-note strong { color: #34466f; font-size: 11px; }
        .health-note small { color: #73809b; font-size: 9.5px; }
        .health-coverage-note { grid-column: 1 / -1; align-items: flex-start; }
        .health-coverage-note span { min-width: 0; }
        .health-coverage-note small { line-height: 1.55; overflow-wrap: anywhere; }
        .health-chart-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .health-panel { min-width: 0; overflow: hidden; border: 1px solid var(--health-border); border-radius: 10px; background: #fff; }
        .health-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 13px; border-bottom: 1px solid #edf0f4; }
        .health-panel > header > span { display: flex; align-items: center; gap: 6px; color: #364459; font-size: 11.5px; font-weight: 700; }
        .health-panel > header > strong { font-size: 14px; }
        .health-panel > header > small { color: var(--health-muted); font-size: 9.5px; }
        :global(.health-chart) { padding: 11px 13px 9px; }
        :global(.health-chart-value) { display: flex; align-items: baseline; gap: 6px; color: #7b8799; font-size: 9px; }
        :global(.health-chart-value strong) { color: #344052; font-size: 13px; }
        :global(.health-chart-value span) { margin-left: auto; }
        :global(.health-chart svg) { display: block; width: 100%; height: 150px; margin-top: 4px; overflow: visible; }
        :global(.health-chart line) { stroke: #edf0f4; stroke-width: 1; }
        :global(.health-chart polyline) { fill: none; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
        :global(.health-chart-axis) { display: flex; justify-content: space-between; color: #8792a3; font-size: 8.5px; }
        :global(.health-chart-empty) { display: grid; height: 205px; place-items: center; color: #8a96a8; font-size: 10.5px; }
        .health-api-summary { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border: 1px solid var(--health-border); border-radius: 10px; background: #fff; }
        .health-api-summary span { display: grid; gap: 3px; padding: 11px 13px; border-right: 1px solid #edf0f4; }
        .health-api-summary span:last-child { border-right: 0; }
        .health-api-summary small { color: var(--health-muted); font-size: 9px; }
        .health-api-summary b { color: #303d50; font-size: 13px; }
        .health-two-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
        .health-list { display: grid; }
        .health-run-history-title { padding: 9px 13px 5px; border-top: 1px solid #edf0f4; color: #6c788b; font-size: 9px; font-weight: 700; letter-spacing: .04em; }
        .health-run-history { max-height: 320px; overflow-y: auto; }
        .health-list-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; min-height: 54px; padding: 8px 13px; border-bottom: 1px solid #edf0f4; }
        .health-list-row:last-child { border-bottom: 0; }
        .health-list-row > span { display: grid; min-width: 0; gap: 3px; }
        .health-list-row > span:last-child { justify-items: end; }
        .health-list-row strong { overflow: hidden; color: #354257; font-size: 10.8px; text-overflow: ellipsis; white-space: nowrap; }
        .health-list-row small { color: var(--health-muted); font-size: 9px; }
        .health-list-row b { color: #354257; font-size: 13px; }
        :global(.health-badge) { display: inline-flex !important; grid-auto-flow: column; align-items: center; justify-content: start; gap: 5px !important; border-radius: 999px; padding: 3px 7px; font-size: 9px; }
        :global(.health-badge i) { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
        :global(.health-badge.ok) { color: #087c70; background: #e9f7f4; }
        :global(.health-badge.warn) { color: #9a6607; background: #fff6dc; }
        :global(.health-badge.error) { color: #b93642; background: #fff0f1; }
        :global(.health-badge.neutral) { color: #667387; background: #f0f2f5; }
        .health-empty { display: grid; min-height: 180px; place-items: center; align-content: center; gap: 6px; border: 1px dashed #dce3ea; border-radius: 10px; color: #168273; }
        .health-empty strong { color: #344052; font-size: 12px; }.health-empty small { color: var(--health-muted); font-size: 9.5px; }
        .health-incident-list { display: grid; gap: 8px; }
        .health-incident { overflow: hidden; border: 1px solid var(--health-border); border-left: 3px solid #d94b57; border-radius: 9px; background: #fff; }
        .health-incident.resolved { border-left-color: #58a396; opacity: .8; }
        .health-incident > header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 11px 13px; border-bottom: 1px solid #edf0f4; }
        .health-incident > header > span:nth-child(2) { display: grid; gap: 3px; }
        .health-incident > header strong { color: #2f3c50; font-size: 11.5px; }
        .health-incident > header small { color: var(--health-muted); font-size: 9px; }
        .health-incident > header > b { color: #68758a; font-size: 9.5px; }
        .health-severity { border-radius: 5px; padding: 4px 6px; background: #fff0f1; color: #bd3441; font-size: 9px; font-weight: 800; }
        .health-severity.p2 { background: #fff6dc; color: #936105; }.health-severity.p3 { background: #eef1f5; color: #596779; }
        .health-incident-detail { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; padding: 10px 13px; color: #455267; font-size: 9.5px; }
        .health-incident-detail > span { display: grid; min-width: 0; gap: 3px; overflow-wrap: anywhere; }
        .health-incident-detail small { color: var(--health-muted); font-size: 8.5px; }
        .health-incident-detail code { color: #4e5f9d; font-size: 9.5px; overflow-wrap: anywhere; white-space: normal; }
        .health-resolution { display: flex; align-items: center; gap: 6px; margin: 0 13px 9px; padding: 7px 9px; border-radius: 6px; background: #edf8f5; color: #24796e; font-size: 9.5px; }
        .health-incident footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 13px; border-top: 1px solid #edf0f4; background: #fafbfc; }
        .health-incident footer label { display: flex; align-items: center; gap: 5px; color: #667387; font-size: 9.5px; }
        .health-incident footer select { max-width: 140px; padding: 4px 22px 4px 6px; }
        .health-incident footer > span { display: flex; gap: 6px; }
        .health-incident footer button { border: 1px solid #d7dee7; border-radius: 6px; padding: 5px 8px; background: #fff; color: #445268; font-size: 9.5px; cursor: pointer; }
        .health-incident footer button.primary { border-color: #5367d5; background: #5367d5; color: #fff; }
        .health-incident footer button:disabled { cursor: wait; opacity: .55; }
        .health-trace-search { display: flex; gap: 8px; padding: 13px; }
        .health-trace-search input { min-width: 0; flex: 1; border: 1px solid #dce2ea; border-radius: 7px; padding: 8px 10px; color: #354257; font-size: 11px; outline: none; }
        .health-trace-search input:focus { border-color: #7181d9; box-shadow: 0 0 0 2px #eef0fb; }
        .health-trace-search button { display: inline-flex; align-items: center; gap: 5px; border: 0; border-radius: 7px; padding: 8px 12px; background: #5367d5; color: #fff; font-size: 10.5px; cursor: pointer; }
        .health-trace-search button:disabled { cursor: default; opacity: .55; }
        .health-trace-error { display: flex; align-items: center; gap: 6px; margin: 0 13px 13px; padding: 8px 10px; border-radius: 7px; background: #fff0f1; color: #b93642; font-size: 10px; }
        .health-trace-result { display: grid; gap: 10px; padding: 0 13px 13px; }
        .health-trace-ids { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid #edf0f4; border-radius: 8px; }
        .health-trace-ids > span { display: grid; min-width: 0; gap: 4px; padding: 9px 10px; border-right: 1px solid #edf0f4; }
        .health-trace-ids > span:last-child { border-right: 0; }
        .health-trace-ids small, .health-trace-event small { color: var(--health-muted); font-size: 8.5px; }
        .health-trace-ids code { color: #4e5f9d; font-size: 9.5px; overflow-wrap: anywhere; white-space: normal; }
        .health-trace-ids b { color: #344052; font-size: 12px; }
        .health-trace-events { display: grid; overflow: hidden; border: 1px solid #edf0f4; border-radius: 8px; }
        .health-trace-event { display: grid; grid-template-columns: auto minmax(130px, 1.1fr) minmax(70px, .5fr) minmax(120px, 1fr) minmax(120px, 1fr); align-items: center; gap: 9px; padding: 9px 10px; border-bottom: 1px solid #edf0f4; color: #455267; font-size: 9.5px; }
        .health-trace-event:last-child { border-bottom: 0; }
        .health-trace-event > span { display: grid; min-width: 0; gap: 3px; overflow-wrap: anywhere; }
        .health-trace-event strong { color: #354257; font-size: 10.5px; }
        .health-trace-event > code { color: #6473a9; font-size: 9.5px; overflow-wrap: anywhere; white-space: normal; }
        @media (max-width: 1050px) { .health-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
        @media (max-width: 760px) {
          .health-head-actions small { display: none; }
          .health-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .health-chart-grid, .health-two-columns { grid-template-columns: 1fr; }
          .health-api-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          .health-api-summary span:nth-child(3) { border-right: 0; }.health-api-summary span:nth-child(-n+3) { border-bottom: 1px solid #edf0f4; }
          .health-incident-detail { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .health-trace-ids { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .health-trace-ids > span:nth-child(2) { border-right: 0; }.health-trace-ids > span:nth-child(-n+2) { border-bottom: 1px solid #edf0f4; }
          .health-trace-event { grid-template-columns: auto minmax(0, 1fr); align-items: start; }
          .health-trace-event > :global(.health-badge) { grid-column: 1; grid-row: 1; }
          .health-trace-event > span:nth-of-type(n+2), .health-trace-event > code { grid-column: 2; }
          .health-incident footer { align-items: stretch; flex-direction: column; }
          .health-incident footer > span { justify-content: flex-end; }
        }
        @media (max-width: 480px) {
          .health-kpis { grid-template-columns: 1fr; }
          .health-toolbar { align-items: flex-end; }
          .health-toolbar button { padding-right: 8px; padding-left: 8px; }
          .health-toolbar > select { max-width: 112px; }
          .health-incident > header { grid-template-columns: auto 1fr; }.health-incident > header > b { grid-column: 2; }
          .health-incident footer > span { display: grid; }
        }
      `}</style>
    </div>
  );
}
