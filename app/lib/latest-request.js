export function beginLatestRequest(ref) {
  const requestId = Number(ref?.current || 0) + 1;
  ref.current = requestId;
  return requestId;
}

export function invalidateLatestRequest(ref) {
  ref.current = Number(ref?.current || 0) + 1;
  return ref.current;
}

export function isLatestRequest(ref, requestId) {
  return Number(ref?.current || 0) === Number(requestId);
}

export async function settleLatestRequest({ ref, requestId, operation, onSuccess, onError, onFinally }) {
  try {
    const value = await operation;
    if (!isLatestRequest(ref, requestId)) return { committed: false, stale: true };
    await onSuccess?.(value);
    return { committed: true, value };
  } catch (error) {
    if (!isLatestRequest(ref, requestId)) return { committed: false, stale: true, error };
    await onError?.(error);
    return { committed: true, error };
  } finally {
    if (isLatestRequest(ref, requestId)) await onFinally?.();
  }
}
