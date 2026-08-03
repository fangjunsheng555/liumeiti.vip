import {
  MONITORED_API_GROUP_NAMES,
  monitoredApiRouteGroup,
} from "./app/api/_telemetry-groups.js";

export const MONITORED_API_ROUTE_GROUPS = new Set(MONITORED_API_GROUP_NAMES);

function normalizedPart(value, fallback = "root") {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

const apiRouteGroup = monitoredApiRouteGroup;

function metricCommands(key, ttlSeconds, group) {
  const prefix = `${group}:`;
  return [
    ["HINCRBY", key, `${prefix}requests`, "1"],
    ["HINCRBY", key, `${prefix}status_5xx`, "1"],
    ["HINCRBY", key, `${prefix}thrown`, "1"],
    ["EXPIRE", key, String(ttlSeconds)],
  ];
}

async function recordUnhandledApiException(groupValue) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  const group = normalizedPart(groupValue, "other").slice(0, 60);
  const now = Date.now();
  const fiveMinute = Math.floor(now / 300_000) * 300_000;
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  const commands = [];
  const metricGroups = MONITORED_API_ROUTE_GROUPS.has(group) ? ["all", group] : ["unmonitored"];
  for (const metricGroup of metricGroups) {
    commands.push(...metricCommands(`lm:obs:api:5m:v1:${fiveMinute}`, 15 * 24 * 60 * 60, metricGroup));
    commands.push(...metricCommands(`lm:obs:api:1h:v1:${hour}`, 180 * 24 * 60 * 60, metricGroup));
  }
  try {
    const response = await fetch(`${String(url).replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    });
    if (!response.ok) return false;
    const rows = await response.json();
    return Array.isArray(rows)
      && rows.length === commands.length
      && rows.every((row) => (
        row
        && typeof row === "object"
        && Object.hasOwn(row, "result")
        && !Object.hasOwn(row, "error")
        && row.result != null
      ));
  } catch {
    return false;
  }
}

export async function register() {
  // Request-error reporting is handled by onRequestError below. Keeping the
  // registration hook explicit makes the instrumentation contract visible to
  // Next.js without starting background work inside a serverless instance.
}

export async function onRequestError(_error, request) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const pathname = request?.path || request?.pathname || "";
  if (!String(pathname).startsWith("/api/")) return;
  // Keep this module Edge-safe: importing the backend utility graph from root
  // instrumentation makes webpack traverse Node-only mail/crypto modules.
  await recordUnhandledApiException(apiRouteGroup(pathname, request?.method));
}

export const instrumentationInternals = { MONITORED_API_ROUTE_GROUPS, apiRouteGroup, recordUnhandledApiException };
