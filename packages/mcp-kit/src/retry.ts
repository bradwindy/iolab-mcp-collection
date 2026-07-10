export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (response: Response | undefined, error: unknown) => boolean;
};

function defaultRetryOn(response: Response | undefined): boolean {
  if (!response) return true;
  return response.status === 429 || response.status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  response?: Response,
): Promise<void> {
  const retryAfterHeader = response?.headers.get("retry-after");
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds)) {
      await sleep(Math.min(seconds * 1000, maxDelayMs));
      return;
    }
  }
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseDelayMs;
  await sleep(Math.min(exponential + jitter, maxDelayMs));
}

/**
 * fetch() with rate-limit-aware exponential backoff. Respects Retry-After.
 * Agents retry enthusiastically on failure; this keeps that client-side instead
 * of hammering upstream NZ public APIs that have modest or unpublished quotas.
 */
export async function fetchWithBackoff(
  input: string | URL,
  init?: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const retryOn = opts.retryOn ?? defaultRetryOn;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetch(input, init);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !retryOn(undefined, error)) throw error;
      await backoffDelay(attempt, baseDelayMs, maxDelayMs);
      continue;
    }

    if (attempt === maxAttempts || !retryOn(response, undefined)) {
      return response;
    }

    await backoffDelay(attempt, baseDelayMs, maxDelayMs, response);
  }

  throw lastError ?? new Error("fetchWithBackoff: exhausted attempts");
}
