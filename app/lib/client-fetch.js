export const CLIENT_FETCH_TIMEOUT_MS = 20_000;

function attachResponseBodyDeadline(response, timeoutMs) {
  if (!response || typeof response.json !== "function") return response;
  const readJson = response.json.bind(response);
  try {
    Object.defineProperty(response, "json", {
      configurable: true,
      writable: true,
      value: (...args) => withClientDeadline(readJson(...args), timeoutMs, "response_body_timeout"),
    });
  } catch {
    // Callers that need a strict guarantee also use withClientDeadline around
    // body parsing. Standard browser and Node Response objects are extensible.
  }
  return response;
}

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

  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    const timeoutError = new Error("请求超时，结果尚未确认，请先刷新核对后再决定是否重试 / Request timed out; verify the result before retrying");
    timeoutError.name = "TimeoutError";
    timeoutError.code = "request_timeout";
    rejectDeadline(timeoutError);
  }, Math.max(1_000, Number(timeoutMs) || CLIENT_FETCH_TIMEOUT_MS));

  try {
    const response = await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      deadline,
    ]);
    return attachResponseBodyDeadline(response, timeoutMs);
  } catch (error) {
    if (timedOut && !abortedByUpstream) {
      if (error?.name === "TimeoutError" && error?.code === "request_timeout") throw error;
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
