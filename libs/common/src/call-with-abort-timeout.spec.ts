import { callWithAbortTimeout } from './call-with-abort-timeout';

describe('callWithAbortTimeout', () => {
  it('aborts and rejects a hanging call after the configured timeout instead of hanging forever', async () => {
    const hangsForever = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });

    await expect(callWithAbortTimeout(hangsForever, 100)).rejects.toThrow(/aborted/i);
  }, 5000);

  it('resolves normally when the call finishes before the timeout', async () => {
    const fast = async () => 'result';
    await expect(callWithAbortTimeout(fast, 2000)).resolves.toBe('result');
  });

  it('propagates a normal (non-timeout) rejection unchanged', async () => {
    const failsFast = async () => {
      throw new Error('a real, non-timeout failure');
    };
    await expect(callWithAbortTimeout(failsFast, 2000)).rejects.toThrow('a real, non-timeout failure');
  });
});
