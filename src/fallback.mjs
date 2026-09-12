export function isRecoverableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}
export async function executeWithFallback(attempt, fallback, { signal } = {}) {
  try {
    const first = await attempt();
    if (first.ok || !isRecoverableStatus(first.status)) return first;
  } catch (e) {
    if (signal?.aborted) throw e;
    if (!["TypeError", "TimeoutError", "AbortError"].includes(e.name)) throw e;
  }
  return fallback();
}
