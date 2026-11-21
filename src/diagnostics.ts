export function errorDetails(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 3) return { message: 'Cause depth limit' };
  if (!(value instanceof Error)) return { message: String(value) };
  const e = value as Error & { code?: unknown; errors?: unknown[]; issues?: unknown; status?: number; retryAfterMs?: number };
  return { name: e.name, message: e.message, stack: e.stack, code: e.code, status: e.status, retryAfterMs: e.retryAfterMs,
    issues: e.issues, cause: e.cause === undefined ? undefined : errorDetails(e.cause, depth + 1),
    errors: e.errors?.slice(0, 5).map(x => errorDetails(x, depth + 1)) };
}
export function transientNetworkError(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  const e = value as Error & { code?: string };
  return /TimeoutError|AbortError/.test(e.name) || /fetch failed|timed out|timeout|HTTP 5\d\d/i.test(e.message)
    || /^(ENOTFOUND|ENOENT|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|UND_ERR_)/.test(e.code ?? '')
    || (e.cause !== undefined && transientNetworkError(e.cause));
}
