"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CreditCard,
  Info,
  Layers3,
  LoaderCircle,
  Minus,
  RefreshCw,
} from "lucide-react";
import { DailyTrendChart } from "./AnalyticsCharts";

const formatNumber = (value, digits = 0) => Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: digits });
const formatMoney = (value) => `¥${formatNumber(value, 2)}`;

function Delta({ value }) {
  if (value == null) return <span className="admin-insights-delta new">新增</span>;
  if (value === 0) return <span className="admin-insights-delta flat"><Minus size={11} />持平</span>;
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={`admin-insights-delta ${value > 0 ? "up" : "down"}`}><Icon size={11} />{Math.abs(value)}%</span>;
}

function Metric({ label, value, hint, delta, showDelta = false, accent = false }) {
  return (
    <article className={`admin-insights-metric${accent ? " accent" : ""}`}>
      <div><span>{label}</span>{showDelta && <Delta value={delta} />}</div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}

function BreakdownRow({ title, amount, meta, share, tone = "default" }) {
  return (
    <div className={`admin-insights-breakdown-row tone-${tone}`}>
      <div><i /><span>{title}</span><small>{meta}</small></div>
      <strong>{amount}</strong>
      <em>{formatNumber(share, 1)}%</em>
    </div>
  );
}

function EmptyState({ children }) {
  return <div className="admin-insights-empty-state">{children}</div>;
}

const RANGES = [
  { days: 7, label: "7 天" },
  { days: 30, label: "30 天" },
  { days: 90, label: "90 天" },
];

const TREND_METRICS = [
  { key: "revenue", label: "成交额", money: true, color: "#0f766e", fill: "rgba(15, 118, 110, 0.12)" },
  { key: "directRevenue", label: "直接支付", money: true, color: "#2563eb", fill: "rgba(37, 99, 235, 0.11)" },
  { key: "codeRevenue", label: "服务码", money: true, color: "#c2410c", fill: "rgba(194, 65, 12, 0.1)" },
  { key: "paid", label: "成交订单", color: "#7c3aed", fill: "rgba(124, 58, 237, 0.1)" },
  { key: "orders", label: "有效订单", color: "#0e7490", fill: "rgba(14, 116, 144, 0.1)" },
  { key: "checkoutStarted", label: "结算发起", color: "#475569", fill: "rgba(71, 85, 105, 0.1)" },
];

const DETAIL_VIEWS = [
  { key: "channels", label: "渠道与来源", icon: CreditCard },
  { key: "services", label: "服务表现", icon: Layers3 },
  { key: "status", label: "订单与累计", icon: Activity },
];

export default function InsightsPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [metric, setMetric] = useState("revenue");
  const [detailView, setDetailView] = useState("channels");

  const load = useCallback(async (range) => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/insights?days=${range}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json();
      if (payload?.ok) setData(payload);
      else setMessage(response.status === 401 ? "当前账号无权查看数据洞察" : "数据加载失败，请稍后重试");
    } catch (error) {
      setMessage("数据加载失败，请检查网络后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  const funnel = data?.funnel;
  const compare = data?.compare;
  const daily = data?.daily || [];
  const selectedMetric = TREND_METRICS.find((item) => item.key === metric) || TREND_METRICS[0];
  const directShare = funnel?.revenue > 0 ? Math.max(0, 100 - Number(funnel.rates?.codeShare || 0)) : 0;

  return (
    <div className="admin-insights">
      <header className="admin-insights-toolbar">
        <div>
          <h2>数据洞察</h2>
          <p>成交、转化与服务经营表现</p>
        </div>
        <div className="admin-insights-toolbar-actions">
          <div className="admin-insights-range" role="group" aria-label="统计周期">
            {RANGES.map((range) => (
              <button
                key={range.days}
                type="button"
                className={days === range.days ? "active" : ""}
                onClick={() => setDays(range.days)}
              >
                {range.label}
              </button>
            ))}
          </div>
          <button type="button" className="admin-insights-refresh" onClick={() => load(days)} disabled={loading} aria-label="刷新数据">
            <RefreshCw size={14} className={loading ? "spin-icon" : ""} />
          </button>
        </div>
      </header>

      <div className="admin-insights-scope-line">
        <Info size={13} />
        <strong>统计口径</strong>
        <span>成交额包含服务码等值；余额码仅在余额支付时计入，无效订单不计。</span>
      </div>

      {message && <div className="admin-insights-error"><AlertTriangle size={15} />{message}</div>}
      {loading && !data ? (
        <div className="admin-insights-loading"><LoaderCircle size={17} className="spin-icon" />正在汇总数据</div>
      ) : funnel && (
        <>
          <section className="admin-insights-metrics" aria-label="核心指标">
            <Metric
              label="成交额"
              value={formatMoney(funnel.revenue)}
              hint={`直接 ${formatMoney(funnel.directRevenue)} · 服务码 ${formatMoney(funnel.codeRevenue)}`}
              delta={compare?.revenue?.delta}
              showDelta
              accent
            />
            <Metric
              label="成交订单"
              value={formatNumber(funnel.paid)}
              hint={`服务码 ${formatNumber(funnel.codeOrders)} 笔 · 有效 ${formatNumber(funnel.orders)} 笔`}
              delta={compare?.paid?.delta}
              showDelta
            />
            <Metric label="客单价" value={formatMoney(funnel.rates.aov)} hint="成交额 / 成交订单" />
            <Metric label="有效订单成交率" value={`${formatNumber(funnel.rates.orderToPaid, 1)}%`} hint="成交订单 / 有效订单" />
          </section>

          <section className="admin-insights-funnel" aria-label="经营漏斗">
            {[
              ["独立访客", funnel.visitors],
              ["服务浏览", funnel.serviceViews],
              ["结算发起", funnel.checkoutStarted],
              ["有效订单", funnel.orders],
              ["成交订单", funnel.paid],
            ].map(([label, value], index) => (
              <div key={label} className={index === 4 ? "active" : ""}>
                <span>{label}</span>
                <strong>{formatNumber(value)}</strong>
                {index < 4 && <i aria-hidden="true">›</i>}
              </div>
            ))}
          </section>

          <div className="admin-insights-dashboard">
            <section className="admin-insights-chart-card">
              <header className="admin-insights-chart-head">
                <div>
                  <h3>每日趋势</h3>
                  <p>按北京时间归集，指向折线查看单日数值</p>
                </div>
                <div className="admin-insights-metric-tabs" role="tablist" aria-label="趋势指标">
                  {TREND_METRICS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      role="tab"
                      aria-selected={metric === item.key}
                      className={metric === item.key ? "active" : ""}
                      style={{ "--metric-color": item.color }}
                      onClick={() => setMetric(item.key)}
                    >
                      <i />{item.label}
                    </button>
                  ))}
                </div>
              </header>
              <DailyTrendChart
                rows={daily}
                valueKey={metric}
                label={selectedMetric.label}
                color={selectedMetric.color}
                fill={selectedMetric.fill}
                money={selectedMetric.money}
              />
            </section>

            <aside className="admin-insights-summary">
              <section>
                <header><h3>成交构成</h3><span>{formatMoney(funnel.revenue)}</span></header>
                <BreakdownRow
                  title="直接支付"
                  amount={formatMoney(funnel.directRevenue)}
                  meta={`${formatNumber(Math.max(0, funnel.paid - funnel.codeOrders))} 笔`}
                  share={directShare}
                  tone="direct"
                />
                <BreakdownRow
                  title="服务码等值"
                  amount={formatMoney(funnel.codeRevenue)}
                  meta={`${formatNumber(funnel.codeOrders)} 笔`}
                  share={funnel.rates.codeShare}
                  tone="code"
                />
                <div className="admin-insights-composition-bar">
                  <i style={{ width: `${Math.min(100, Math.max(0, directShare))}%` }} />
                  <b />
                </div>
              </section>
              <section className="admin-insights-health">
                <header><h3>订单质量</h3><span>{days} 天</span></header>
                {[
                  ["订单完成率", `${formatNumber(funnel.rates.orderCompletion, 1)}%`],
                  ["结算承接率", `${formatNumber(funnel.rates.checkoutToOrder, 1)}%`],
                  ["每百访客成交", `${formatNumber(funnel.rates.ordersPer100Visitors, 1)} 单`],
                  ["服务码金额占比", `${formatNumber(funnel.rates.codeShare, 1)}%`],
                ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
              </section>
            </aside>
          </div>

          <section className="admin-insights-detail">
            <header>
              <div>
                <h3>经营拆解</h3>
                <p>切换查看渠道、服务或订单状态</p>
              </div>
              <div className="admin-insights-detail-tabs" role="tablist" aria-label="经营拆解视图">
                {DETAIL_VIEWS.map((view) => {
                  const Icon = view.icon;
                  return (
                    <button
                      key={view.key}
                      type="button"
                      role="tab"
                      aria-selected={detailView === view.key}
                      className={detailView === view.key ? "active" : ""}
                      onClick={() => setDetailView(view.key)}
                    >
                      <Icon size={13} />{view.label}
                    </button>
                  );
                })}
              </div>
            </header>

            {detailView === "channels" && (
              <div className="admin-insights-detail-columns">
                <div className="admin-insights-detail-column">
                  <h4>支付渠道</h4>
                  {(data.payments || []).length === 0 ? <EmptyState>暂无支付数据</EmptyState> : (
                    <div className="admin-insights-breakdown-list">
                      {data.payments.map((row) => (
                        <div key={row.key}>
                          <span>{row.label}<small>有效 {formatNumber(row.orders)} · 成交 {formatNumber(row.paid)}</small></span>
                          <strong>{formatMoney(row.revenue)}</strong>
                          <em>{formatNumber(row.revenueShare, 1)}%</em>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="admin-insights-detail-column">
                  <h4>订单来源</h4>
                  {(data.bySource || []).length === 0 ? <EmptyState>当前周期暂无订单</EmptyState> : (
                    <div className="admin-insights-breakdown-list">
                      {data.bySource.map((row) => (
                        <div key={row.source}>
                          <span>{row.source}<small>有效 {formatNumber(row.orders)} · 服务码 {formatNumber(row.codeOrders)}</small></span>
                          <strong>{formatMoney(row.revenue)}</strong>
                          <em>{formatNumber(row.completionRate, 1)}%</em>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {detailView === "services" && (
              <div className="admin-insights-table-wrap admin-insights-service-table">
                <table>
                  <thead><tr><th>服务</th><th>浏览 / 点击</th><th>有效 / 成交</th><th>服务码</th><th>直接支付</th><th>服务码等值</th><th>成交额</th><th>占比</th></tr></thead>
                  <tbody>
                    {(data.services || []).map((row) => (
                      <tr key={row.key}>
                        <td><strong>{row.name}</strong>{!row.active && <small>已下架</small>}</td>
                        <td>{formatNumber(row.views)} / {formatNumber(row.cta)}</td>
                        <td>{formatNumber(row.orders)} / {formatNumber(row.paid)}<small>{formatNumber(row.completionRate, 1)}%</small></td>
                        <td>{formatNumber(row.codeOrders)}</td>
                        <td>{formatMoney(row.directRevenue)}</td>
                        <td>{formatMoney(row.codeRevenue)}</td>
                        <td><b>{formatMoney(row.revenue)}</b></td>
                        <td>{formatNumber(row.revenueShare, 1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {detailView === "status" && (
              <div className="admin-insights-status-view">
                <div>
                  <h4>当前周期订单状态</h4>
                  <div className="admin-insights-status-list">
                    {(data.statuses || []).map((row) => (
                      <div key={row.key} className={`status-${row.key}`}>
                        <span>{row.label}</span>
                        <div><i style={{ width: `${Math.min(100, row.share)}%` }} /></div>
                        <strong>{formatNumber(row.count)}</strong>
                        <small>{formatNumber(row.share, 1)}%</small>
                      </div>
                    ))}
                  </div>
                </div>
                {data.totals && (
                  <div>
                    <h4>全站累计</h4>
                    <div className="admin-insights-lifetime-grid">
                      {[
                        ["独立访客", formatNumber(data.totals.visitorsAll)],
                        ["注册用户", formatNumber(data.totals.signups)],
                        ["有效订单", formatNumber(data.totals.ordersAll)],
                        ["成交订单", formatNumber(data.totals.paidAll)],
                        ["服务码订单", formatNumber(data.totals.codeOrdersAll)],
                        ["直接支付", formatMoney(data.totals.directRevenueAll)],
                        ["服务码等值", formatMoney(data.totals.codeRevenueAll)],
                        ["累计成交额", formatMoney(data.totals.revenueAll)],
                      ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
