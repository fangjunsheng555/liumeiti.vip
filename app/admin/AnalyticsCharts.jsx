"use client";

import { useState } from "react";

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 8 ? `${digits.slice(4, 6)}-${digits.slice(6, 8)}` : String(value || "");
}

function longDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 8) return String(value || "");
  return `${Number(digits.slice(4, 6))}月${Number(digits.slice(6, 8))}日`;
}

function formatNumber(value, maximumFractionDigits = 0) {
  return numberValue(value).toLocaleString("zh-CN", { maximumFractionDigits });
}

function formatMoney(value) {
  return `¥${numberValue(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

function formatAxis(value, money) {
  const amount = numberValue(value);
  const abs = Math.abs(amount);
  let output;
  if (abs >= 1000000) output = `${(amount / 1000000).toFixed(abs >= 10000000 ? 0 : 1)}m`;
  else if (abs >= 1000) output = `${(amount / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  else output = Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
  return money ? `¥${output}` : output;
}

function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const power = 10 ** exponent;
  const fraction = rawStep / power;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return niceFraction * power;
}

function axisScale(maxValue, tickCount = 4, integer = false) {
  const max = Math.max(0, numberValue(maxValue));
  const calculatedStep = niceStep(max / tickCount);
  const step = integer ? Math.max(1, Math.ceil(calculatedStep)) : Math.max(max <= tickCount ? 1 : 0, calculatedStep);
  const axisMax = Math.max(tickCount, step * tickCount);
  return {
    max: axisMax,
    ticks: Array.from({ length: tickCount + 1 }, (_, index) => step * index),
  };
}

function sampleIndices(length, count) {
  if (length <= 0) return [];
  if (length <= count) return Array.from({ length }, (_, index) => index);
  return Array.from(new Set(
    Array.from({ length: count }, (_, index) => Math.round((index * (length - 1)) / (count - 1))),
  ));
}

function TimeSeriesPlot({ rows, valueKey, color, fill, money = false, suffix = "", compact = false, ariaLabel }) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const data = (Array.isArray(rows) ? rows : []).map((row) => ({
    date: row?.date || "",
    value: Math.max(0, numberValue(row?.[valueKey])),
  }));

  if (!data.length) return <div className="admin-chart-empty">暂无趋势数据</div>;

  const width = compact ? 420 : 760;
  const height = compact ? 158 : 270;
  const padding = compact
    ? { left: 42, right: 10, top: 10, bottom: 27 }
    : { left: 54, right: 14, top: 12, bottom: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const baseline = padding.top + plotHeight;
  const maxValue = Math.max(0, ...data.map((item) => item.value));
  const scale = axisScale(maxValue, 4, !money);
  const stepX = data.length > 1 ? plotWidth / (data.length - 1) : plotWidth;
  const xFor = (index) => data.length > 1 ? padding.left + index * stepX : padding.left + plotWidth / 2;
  const yFor = (value) => padding.top + plotHeight - (value / scale.max) * plotHeight;
  const points = data.map((item, index) => ({ ...item, x: xFor(index), y: yFor(item.value) }));
  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(2)},${baseline} L${points[0].x.toFixed(2)},${baseline} Z`;
  const shownIndex = activeIndex >= 0 && activeIndex < data.length ? activeIndex : data.length - 1;
  const active = points[shownIndex];
  const xLabels = new Set(sampleIndices(data.length, compact ? 4 : 6));
  const showAllPoints = data.length <= 31;
  const valueText = money ? formatMoney(active.value) : `${formatNumber(active.value)}${suffix ? ` ${suffix}` : ""}`;

  return (
    <div
      className={`admin-time-series-chart${compact ? " compact" : " large"}`}
      style={{ "--chart-color": color, "--chart-fill": fill }}
    >
      <div className="admin-chart-readout" aria-live="polite">
        <span>{longDate(active.date)}</span>
        <strong>{valueText}</strong>
      </div>
      <div className="admin-chart-scroll">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaLabel}
          onMouseLeave={() => setActiveIndex(-1)}
        >
          {scale.ticks.map((tick) => {
            const y = yFor(tick);
            return (
              <g key={tick}>
                <line className="admin-chart-grid" x1={padding.left} y1={y} x2={width - padding.right} y2={y} />
                <text className="admin-chart-axis-label" x={padding.left - 7} y={y + 3} textAnchor="end">{formatAxis(tick, money)}</text>
              </g>
            );
          })}

          <path className="admin-chart-area" d={areaPath} />
          <path className="admin-chart-line" d={linePath} />

          <line className="admin-chart-crosshair" x1={active.x} y1={padding.top} x2={active.x} y2={baseline} />

          {points.map((point, index) => {
            const hitLeft = index === 0 ? padding.left : (points[index - 1].x + point.x) / 2;
            const hitRight = index === points.length - 1 ? width - padding.right : (point.x + points[index + 1].x) / 2;
            return (
            <g key={`${point.date}-${index}`}>
              {(showAllPoints || index === shownIndex) && (
                <circle
                  className={`admin-chart-point${index === shownIndex ? " active" : ""}`}
                  cx={point.x}
                  cy={point.y}
                  r={index === shownIndex ? 4 : 2.2}
                />
              )}
              <rect
                className="admin-chart-hit"
                x={hitLeft}
                y={padding.top}
                width={Math.max(6, hitRight - hitLeft)}
                height={plotHeight}
                tabIndex={xLabels.has(index) ? 0 : -1}
                aria-label={`${longDate(point.date)}，${money ? formatMoney(point.value) : `${formatNumber(point.value)}${suffix}`}`}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onClick={() => setActiveIndex(index)}
              >
                <title>{longDate(point.date)}：{money ? formatMoney(point.value) : `${formatNumber(point.value)}${suffix}`}</title>
              </rect>
            </g>
            );
          })}

          {points.map((point, index) => xLabels.has(index) && (
            <text
              key={`date-${point.date}-${index}`}
              className="admin-chart-axis-label x"
              x={point.x}
              y={height - 7}
              textAnchor={index === 0 ? "start" : index === data.length - 1 ? "end" : "middle"}
            >
              {shortDate(point.date)}
            </text>
          ))}
        </svg>
      </div>
      {!compact && <span className="admin-chart-swipe-hint">左右滑动查看完整周期</span>}
    </div>
  );
}

export function OverviewTrendCard({ title, rows, valueKey, color, fill, money = false, suffix = "" }) {
  const data = Array.isArray(rows) ? rows : [];
  const values = data.map((row) => Math.max(0, numberValue(row?.[valueKey])));
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = values.length ? total / values.length : 0;
  const peak = values.length ? Math.max(...values) : 0;
  const today = values.length ? values[values.length - 1] : 0;
  const display = (value, averageValue = false) => money
    ? formatMoney(value)
    : `${formatNumber(value, averageValue ? 1 : 0)}${suffix ? ` ${suffix}` : ""}`;

  return (
    <article className="admin-overview-trend-card" style={{ "--chart-color": color }}>
      <header className="admin-overview-chart-head">
        <div>
          <span>{title}</span>
          <small>{data.length ? `${shortDate(data[0]?.date)} 至 ${shortDate(data[data.length - 1]?.date)}` : "暂无日期"}</small>
        </div>
        <strong>{display(total)}</strong>
      </header>
      <div className="admin-overview-chart-kpis">
        <span>日均 <b>{display(average, true)}</b></span>
        <span>峰值 <b>{display(peak)}</b></span>
        <span>今日 <b>{display(today)}</b></span>
      </div>
      <TimeSeriesPlot
        rows={data}
        valueKey={valueKey}
        color={color}
        fill={fill}
        money={money}
        suffix={suffix}
        compact
        ariaLabel={`${title}折线图`}
      />
    </article>
  );
}

export function DailyTrendChart({ rows, valueKey, label, color, fill, money = false }) {
  const data = Array.isArray(rows) ? rows : [];
  const values = data.map((row) => Math.max(0, numberValue(row?.[valueKey])));
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = values.length ? total / values.length : 0;
  const peak = values.length ? Math.max(...values) : 0;
  const peakIndex = values.indexOf(peak);
  const display = (value, averageValue = false) => money
    ? formatMoney(value)
    : formatNumber(value, averageValue ? 1 : 0);

  return (
    <div className="admin-insights-chart-body" style={{ "--chart-color": color }}>
      <div className="admin-insights-chart-kpis">
        <div><span>周期合计</span><strong>{display(total)}</strong></div>
        <div><span>日均</span><strong>{display(average, true)}</strong></div>
        <div><span>单日峰值</span><strong>{display(peak)}</strong><small>{peakIndex >= 0 ? shortDate(data[peakIndex]?.date) : "—"}</small></div>
      </div>
      <TimeSeriesPlot
        rows={data}
        valueKey={valueKey}
        color={color}
        fill={fill}
        money={money}
        compact={false}
        ariaLabel={`${label}每日趋势折线图`}
      />
    </div>
  );
}
