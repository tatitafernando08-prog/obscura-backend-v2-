import { Worker } from 'worker_threads';

const DEFAULT_TIMEOUT_MS = 30000;

export interface RunWorkerOptions {
  timeoutMs?: number;
}

/**
 * Runs a worker_threads.Worker to completion and resolves with whatever it
 * `postMessage`s. Guards the two ways a worker can fail silently instead of
 * rejecting cleanly: exiting (killed, OOM, an internal `process.exit()`)
 * without ever posting a message, and hanging indefinitely without exiting
 * or posting -- both would otherwise leave the returned promise (and
 * whatever awaits it) stuck forever.
 */
export function runWorker<T>(
  workerPath: string,
  execArgv: string[],
  workerData: unknown,
  options: RunWorkerOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerPath, { execArgv, workerData });

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`Worker at ${workerPath} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      action();
    }

    worker.once('message', (msg: T) => settle(() => resolve(msg)));
    worker.once('error', (err) => settle(() => reject(err)));
    worker.once('exit', (code) => {
      settle(() =>
        reject(new Error(`Worker at ${workerPath} exited with code ${code} before sending a result`)),
      );
    });
  });
}
