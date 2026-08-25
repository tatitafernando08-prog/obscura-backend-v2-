/**
 * Runs `fn` with an AbortSignal that fires after `timeoutMs`, so a call that
 * would otherwise hang forever (observed live: Gemini's `generateContent`
 * under sustained load sometimes returns zero bytes indefinitely instead of
 * a fast error) rejects on a bounded schedule instead. `fn` itself must
 * respect the signal (pass it through to a fetch-based SDK call) for the
 * abort to actually cut the in-flight request short, not just this promise.
 */
export async function callWithAbortTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
