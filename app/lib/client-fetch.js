export const CLIENT_FETCH_TIMEOUT_MS = 20_000;

/**
 * Browser fetch with a finite deadline. The caller's AbortSignal is preserved,
 * while a deadline abort is surfaced as a distinct TimeoutError so UI code can
 * always leave its loading state and offer a safe retry.
 */
export async function clientFetch(input, init = {}, timeoutMs = CLIENT_FETCH_TIMEOUT_MS) {
  if (typeof AbortController === "undefined") return fetch(input, init);

  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  let timedOut = false;
  let abortedByUpstream = false;

  const relayAbort = () => {
    abortedByUpstream = true;
    controller.abort(upstreamSignal?.reason);
  };
  if (upstreamSignal?.aborted) relayAbort();
  else upstreamSignal?.addEventListener?.("abort", relayAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1_000, Number(timeoutMs) || CLIENT_FETCH_TIMEOUT_MS));

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut && !abortedByUpstream) {
      const timeoutError = new Error("请求超时，结果尚未确认，请先刷新核对后再决定是否重试 / Request timed out; verify the result before retrying");
      timeoutError.name = "TimeoutError";
      timeoutError.code = "request_timeout";
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener?.("abort", relayAbort);
  }
}

export function isClientRequestTimeout(error) {
  return error?.name === "TimeoutError" || error?.code === "request_timeout";
}

export async function withClientDeadline(promise, timeoutMs = CLIENT_FETCH_TIMEOUT_MS, code = "client_operation_timeout") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(code);
      error.name = "TimeoutError";
      error.code = code;
      reject(error);
    }, Math.max(1_000, Number(timeoutMs) || CLIENT_FETCH_TIMEOUT_MS));
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
