export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  isRetryable: (error: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` with exponential backoff, but only for errors `isRetryable`
 * accepts -- e.g. Gemini's transient 503 "high demand" responses, never its
 * 429 daily-quota responses, which retrying can't fix and would only waste
 * more of the same exhausted quota.
 */
export async function callWithRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, baseDelayMs, isRetryable } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !isRetryable(err)) {
        throw err;
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}
