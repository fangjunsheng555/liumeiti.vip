export const NETFLIX_REQUEST_TIMEOUT_MS = 15 * 1000;

// Keep the deadline active until the response body has been consumed. A fetch
// promise resolves as soon as headers arrive, while response.json() can still
// hang indefinitely on a stalled upstream body.
export async function fetchNetflixJson(input, init, timeoutMs) {
  const options = init && typeof init === "object" ? init : {};
  const requestedTimeout = Number(timeoutMs);
  const deadline = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.floor(requestedTimeout)
    : NETFLIX_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener?.("abort", abortFromUpstream, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort(), deadline);
  try {
    const response = await fetch(input, { ...options, signal: controller.signal });
    const data = await response.json();
    return { response, data };
  } finally {
    globalThis.clearTimeout(timer);
    upstreamSignal?.removeEventListener?.("abort", abortFromUpstream);
  }
}
