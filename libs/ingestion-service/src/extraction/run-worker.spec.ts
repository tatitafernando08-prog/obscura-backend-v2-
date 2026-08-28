import { join } from 'path';
import { runWorker } from './run-worker';

const TS_NODE_EXEC_ARGV = ['-r', 'ts-node/register/transpile-only'];
const SILENT_EXIT_WORKER = join(__dirname, '__test-fixtures__/silent-exit.worker.ts');
const HANGS_FOREVER_WORKER = join(__dirname, '__test-fixtures__/hangs-forever.worker.ts');

describe('runWorker', () => {
  it('resolves with the worker-posted message on a normal run', async () => {
    // pdf-parse.worker.ts is a real, well-behaved worker: reuse it directly
    // rather than adding a third fixture just to prove the happy path.
    const worker = join(__dirname, 'pdf-parse.worker.ts');
    const pdfBuffer = Buffer.from('%PDF-1.4\nnot a real pdf, just proving message plumbing');

    const result = await runWorker<{ text?: string; error?: string }>(worker, TS_NODE_EXEC_ARGV, {
      pdfBuffer,
    });

    // Malformed input, so pdf-parse itself fails -- what matters here is that
    // the *worker's own message* made it back, not what it says.
    expect(result.error).toBeDefined();
  }, 15000);

  it('rejects instead of hanging forever when the worker exits without posting a message', async () => {
    await expect(
      runWorker(SILENT_EXIT_WORKER, TS_NODE_EXEC_ARGV, {}, { timeoutMs: 5000 }),
    ).rejects.toThrow(/exited/i);
  }, 10000);

  it('rejects via timeout instead of hanging forever when the worker never responds', async () => {
    await expect(
      runWorker(HANGS_FOREVER_WORKER, TS_NODE_EXEC_ARGV, {}, { timeoutMs: 500 }),
    ).rejects.toThrow(/timed out/i);
  }, 10000);
});
