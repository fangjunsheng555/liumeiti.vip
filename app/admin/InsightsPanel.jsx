"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Info,
  LoaderCircle,
  Minus,
  RefreshCw,
} from "lucide-react";
import { DailyTrendChart } from "./AnalyticsCharts";

const formatNumber = (value, digits = 0) => Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: digits });
const formatMoney = (value) => `¥${formatNumber(value, 2)}`;

function Delta({ value }) {
  if (value == null) return <span className="admin-insights-delta new">新增</span>;
  if (value === 0) return <span className="admin-insights-delta flat"><Minus size={12} />持平</span>;
  const UpIcon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={`admin-insights-delta ${value > 0 ? "up" : "down"}`}><UpIcon size={12} />{Math.abs(value)}%</span>;
}

function MetricCard({ label, value, delta, hint, accent = false }) {
  return (
    <article className={`admin-insights-kpi${accent ? " accent" : ""}`}>
      <div><span>{label}</span><Delta value={delta} /></div>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </article>
  );
}

function EmptyRow({ columns, children }) {
  return <tr><td className="admin-insights-empty" colSpan={columns}>{children}</td></tr>;
}

const RANGES = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
];

const TREND_METRICS = [
  { key: "revenue", label: "成交额", money: true, color: "#0f766e", fill: "rgba(15, 118, 110, 0.12)" },
  { key: "directRevenue", label: "直接支付", money: true, color: "#2563eb", fill: "rgba(37, 99, 235, 0.11)" },
  { key: "codeRevenue", label: "兑换码等值", money: true, color: "#c2410c", fill: "rgba(194, 65, 12, 0.1)" },
  { key: "paid", label: "成交订单", color: "#7c3aed", fill: "rgba(124, 58, 237, 0.1)" },
  { key: "codeOrders", label: "兑换码订单", color: "#b45309", fill: "rgba(180, 83, 9, 0.1)" },
  { key: "orders", label: "有效订单", color: "#0e7490", fill: "rgba(14, 116, 144, 0.1)" },
  { key: "checkoutStarted", label: "结算发起", color: "#475569", fill: "rgba(71, 85, 105, 0.1)" },
  { key: "serviceViews", label: "服务浏览", color: "#4f46e5", fill: "rgba(79, 70, 229, 0.1)" },
];

export default function InsightsPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [metric, setMetric] = useState("revenue");

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
          <p>经营结果、订单质量、渠道与服务表现</p>
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
          <button type="button" className="admin-insights-refresh" onClick={() => load(days)} disabled={loading}>
            <RefreshCw size={14} className={loading ? "spin-icon" : ""} />
            <span>{loading ? "刷新中" : "刷新"}</span>
          </button>
        </div>
      </header>

      <div className="admin-insights-scope">
        <Info size={16} />
        <p>
          <strong>成交额已包含服务兑换码</strong>
          <span>服务码按订单商品金额计入；余额码仅在余额支付时计入，避免重复。成交口径：已完成、服务码已核销、余额已扣款或 USDT 已确认；无效订单不计。</span>
        </p>
      </div>

      {message && <div className="admin-insights-error"><AlertTriangle size={15} />{message}</div>}
      {loading && !data ? (
        <div className="admin-insights-loading"><LoaderCircle size={17} className="spin-icon" />正在汇总数据</div>
      ) : funnel && (
        <>
          <section className="admin-insights-kpi-grid" aria-label="核心指标">
            <MetricCard label="独立访客" value={formatNumber(funnel.visitors)} delta={compare?.visitors?.delta} hint="当前周期去重设备" />
            <MetricCard label="服务浏览" value={formatNumber(funnel.serviceViews)} delta={compare?.serviceViews?.delta} hint="当前周期浏览次数" />
            <MetricCard label="结算发起" value={formatNumber(funnel.checkoutStarted)} delta={compare?.checkoutStarted?.delta} hint="进入结算次数" />
            <MetricCard label="有效订单" value={formatNumber(funnel.orders)} delta={compare?.orders?.delta} hint={`排除 ${formatNumber(funnel.invalid)} 笔无效订单`} />
            <MetricCard label="成交订单" value={formatNumber(funnel.paid)} delta={compare?.paid?.delta} hint={`其中服务码 ${formatNumber(funnel.codeOrders)} 笔`} />
            <MetricCard label="成交额" value={formatMoney(funnel.revenue)} delta={compare?.revenue?.delta} hint="直接支付 + 服务码等值" accent />
          </section>

          <section className="admin-insights-revenue" aria-label="成交额构成">
            <div className="admin-insights-revenue-total">
              <span>当前周期成交额</span>
              <strong>{formatMoney(funnel.revenue)}</strong>
              <small>{formatNumber(funnel.paid)} 笔成交 · 客单价 {formatMoney(funnel.rates.aov)}</small>
            </div>
            <div className="admin-insights-revenue-parts">
              <div>
                <span><i className="direct" />直接支付</span>
                <strong>{formatMoney(funnel.directRevenue)}</strong>
                <small>{formatNumber(directShare, 1)}%</small>
              </div>
              <div>
                <span><i className="code" />服务码等值</span>
                <strong>{formatMoney(funnel.codeRevenue)}</strong>
                <small>{formatNumber(funnel.rates.codeShare, 1)}% · {formatNumber(funnel.codeOrders)} 笔</small>
              </div>
              <div className="admin-insights-revenue-bar" aria-label={`直接支付 ${directShare}%，服务码等值 ${funnel.rates.codeShare}%`}>
                <i style={{ width: `${Math.min(100, Math.max(0, directShare))}%` }} />
                <b />
              </div>
            </div>
          </section>

          <section className="admin-insights-quality" aria-label="订单质量">
            <div><span>有效订单成交率</span><strong>{formatNumber(funnel.rates.orderToPaid, 1)}%</strong><small>成交订单 / 有效订单</small></div>
            <div><span>订单完成率</span><strong>{formatNumber(funnel.rates.orderCompletion, 1)}%</strong><small>已完成 / 有效订单</small></div>
            <div><span>结算承接率</span><strong>{formatNumber(funnel.rates.checkoutToOrder, 1)}%</strong><small>有效订单 / 结算发起</small></div>
            <div><span>每百访客成交</span><strong>{formatNumber(funnel.rates.ordersPer100Visitors, 1)} 单</strong><small>允许包含复购</small></div>
            <div><span>服务码金额占比</span><strong>{formatNumber(funnel.rates.codeShare, 1)}%</strong><small>服务码等值 / 成交额</small></div>
          </section>

          <section className="admin-insights-chart-card">
            <header className="admin-insights-chart-head">
              <div>
                <h3>每日趋势</h3>
                <p>按北京时间归集，移动指针可查看具体日期与数值</p>
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

          <div className="admin-insights-split">
            <section className="admin-insights-section">
              <header><div><h3>支付渠道</h3><p>当前周期有效订单与成交额构成</p></div></header>
              <div className="admin-insights-table-wrap compact">
                <table>
                  <thead><tr><th>渠道</th><th>有效</th><th>成交</th><th>成交额</th><th>占比</th></tr></thead>
                  <tbody>
                    {(data.payments || []).length === 0 ? <EmptyRow columns={5}>暂无支付数据</EmptyRow> : data.payments.map((row) => (
                      <tr key={row.key}>
                        <td><strong>{row.label}</strong>{row.key === "redeem" && <small>线下销售等值</small>}</td>
                        <td>{formatNumber(row.orders)}</td>
                        <td>{formatNumber(row.paid)}<small>{formatNumber(row.completionRate, 1)}%</small></td>
                        <td><b>{formatMoney(row.revenue)}</b><small>客单 {formatMoney(row.aov)}</small></td>
                        <td>{formatNumber(row.revenueShare, 1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="admin-insights-section admin-insights-status-section">
              <header><div><h3>订单状态</h3><p>包含无效订单，便于识别待处理积压</p></div></header>
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
            </section>
          </div>

          <section className="admin-insights-section">
            <header><div><h3>订单来源</h3><p>当前周期有效订单；成交额同时拆分直接支付与服务码等值</p></div></header>
            <div className="admin-insights-table-wrap">
              <table>
                <thead><tr><th>来源</th><th>有效订单</th><th>成交</th><th>服务码</th><th>直接支付</th><th>服务码等值</th><th>成交额</th><th>成交率</th></tr></thead>
                <tbody>
                  {(data.bySource || []).length === 0 ? <EmptyRow columns={8}>当前周期暂无订单</EmptyRow> : data.bySource.map((row) => (
                    <tr key={row.source}>
                      <td><strong>{row.source}</strong></td>
                      <td>{formatNumber(row.orders)}</td>
                      <td>{formatNumber(row.paid)}</td>
                      <td>{formatNumber(row.codeOrders)}</td>
                      <td>{formatMoney(row.directRevenue)}</td>
                      <td>{formatMoney(row.codeRevenue)}</td>
                      <td><b>{formatMoney(row.revenue)}</b></td>
                      <td>{formatNumber(row.completionRate, 1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="admin-insights-section">
            <header>
              <div><h3>服务表现</h3><p>订单与成交额按当前周期统计；浏览和下单点击为全站累计</p></div>
              <span className="admin-insights-period-badge">订单 {days} 天 · 流量累计</span>
            </header>
            <div className="admin-insights-table-wrap">
              <table>
                <thead><tr><th>服务</th><th>累计流量</th><th>有效 / 成交</th><th>服务码</th><th>直接支付</th><th>服务码等值</th><th>成交额</th><th>成交率</th><th>金额占比</th></tr></thead>
                <tbody>
                  {(data.services || []).map((row) => (
                    <tr key={row.key}>
                      <td><strong>{row.name}</strong>{!row.active && <small>当前已下架</small>}</td>
                      <td>{formatNumber(row.views)} / {formatNumber(row.cta)}<small>浏览 / 点击</small></td>
                      <td>{formatNumber(row.orders)} / {formatNumber(row.paid)}</td>
                      <td>{formatNumber(row.codeOrders)}</td>
                      <td>{formatMoney(row.directRevenue)}</td>
                      <td>{formatMoney(row.codeRevenue)}</td>
                      <td><b>{formatMoney(row.revenue)}</b></td>
                      <td>{formatNumber(row.completionRate, 1)}%</td>
                      <td>{formatNumber(row.revenueShare, 1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {data.totals && (
            <section className="admin-insights-totals">
              <header><h3>全站累计</h3><p>自上线以来，沿用同一成交额口径</p></header>
              <div>
                {[
                  ["独立访客", formatNumber(data.totals.visitorsAll)],
                  ["注册用户", formatNumber(data.totals.signups)],
                  ["服务浏览", formatNumber(data.totals.serviceViewsAll)],
                  ["结算发起", formatNumber(data.totals.checkoutStartedAll)],
                  ["有效订单", formatNumber(data.totals.ordersAll)],
                  ["成交订单", formatNumber(data.totals.paidAll)],
                  ["服务码订单", formatNumber(data.totals.codeOrdersAll)],
                  ["直接支付", formatMoney(data.totals.directRevenueAll)],
                  ["服务码等值", formatMoney(data.totals.codeRevenueAll)],
                  ["累计成交额", formatMoney(data.totals.revenueAll)],
                ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
