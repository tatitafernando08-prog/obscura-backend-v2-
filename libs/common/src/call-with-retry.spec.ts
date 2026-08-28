import { callWithRetry } from './call-with-retry';

describe('callWithRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the result immediately when the first attempt succeeds', async () => {
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 10, isRetryable: () => true });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and returns the eventual success', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');

    const promise = callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 10, isRetryable: () => true });
    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable failure -- rejects immediately with the original error', async () => {
    const err = new Error('permanent');
    const fn = jest.fn().mockRejectedValue(err);

    await expect(
      callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 10, isRetryable: () => false }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects with the last error once maxAttempts is exhausted on a persistently retryable failure', async () => {
    const err1 = new Error('fail 1');
    const err2 = new Error('fail 2');
    const err3 = new Error('fail 3');
    const fn = jest.fn()
      .mockRejectedValueOnce(err1)
      .mockRejectedValueOnce(err2)
      .mockRejectedValueOnce(err3);

    const promise = callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 10, isRetryable: () => true });
    promise.catch(() => {});
    await jest.advanceTimersByTimeAsync(10);
    await jest.advanceTimersByTimeAsync(20);

    await expect(promise).rejects.toBe(err3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('applies exponential backoff between attempts', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');

    const promise = callWithRetry(fn, { maxAttempts: 3, baseDelayMs: 100, isRetryable: () => true });

    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(199);
    expect(fn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(promise).resolves.toBe('ok');
  });
});
