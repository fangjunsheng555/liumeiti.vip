"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";

const STATUS = {
  ok: { label: "正常", tone: "ok" },
  warning: { label: "待确认", tone: "warn" },
  error: { label: "异常", tone: "error" },
  disabled: { label: "未启用", tone: "neutral" },
};

function compactTime(value) {
  const match = String(value || "").match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  return match ? `${match[1].slice(5)} ${match[2]}` : "尚无记录";
}

function metricText(metrics) {
  return Object.entries(metrics || {}).slice(0, 4).map(([key, value]) => `${key} ${value}`);
}

export default function SystemHealthPanel() {
  const [data, setData] = useState({ components: [], counts: {} });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/health", { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "load_failed");
      setData(payload);
    } catch (error) {
      setMessage(error?.message === "unauthorized" ? "仅超级管理员可查看系统健康状态" : "系统状态加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="admin-compact-page">
      <header className="admin-compact-head">
        <div><h2><Activity size={18} />系统健康</h2><p>关键服务最近一次运行状态</p></div>
        <button type="button" onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? "spin-icon" : ""} />刷新</button>
      </header>

      <div className="admin-status-strip admin-health-summary" aria-label="系统健康概览">
        <span className="ok"><b>{Number(data.counts?.ok || 0)}</b>正常</span>
        <span><b>{Number(data.counts?.warning || 0)}</b>待确认</span>
        <span className={data.counts?.error ? "error" : ""}><b>{Number(data.counts?.error || 0)}</b>异常</span>
        <span><b>{Number(data.counts?.disabled || 0)}</b>未启用</span>
      </div>

      {message && <div className="admin-inline-error"><AlertTriangle size={14} />{message}</div>}
      <div className="admin-health-table" aria-busy={loading}>
        <div className="admin-health-table-head"><span>服务</span><span>状态</span><span>最近检查</span><span>运行信息</span></div>
        {data.components.map((item) => {
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
    </div>
  );
}
