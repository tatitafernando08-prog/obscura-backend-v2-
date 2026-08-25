import { join } from 'path';
import { runWorker } from './run-worker';
// Side-effect-only import: forces tsc's import-reachability analysis to
// compile pdf-parse.worker.ts into dist (it's otherwise only referenced via
// the runtime string path below, which tsc can't see). Guarded internally by
// `isMainThread` so requiring it here never runs the actual parse.
import './pdf-parse.worker';

// pdf-parse's bundled pdf.js corrupts its own internal parse state when
// unrelated concurrent Node I/O (e.g. this process's live gRPC/HTTPS calls to
// Gemini/Cohere/Supabase) races it on the main thread -- reproduced reliably
// (see pdf-parse-in-worker.spec.ts) and confirmed via SHA-256 hashing that the
// *input* buffer is never mutated, so the corruption is inside pdf.js's own
// buffers, almost certainly Node's shared small-Buffer pool being reused
// across the race. A worker thread has its own V8 isolate and its own
// per-thread Buffer pool, so it structurally cannot share that pool with the
// main thread -- this isn't a probabilistic mitigation, the shared-memory
// precondition for the bug simply doesn't exist across the thread boundary.
//
// Jest/ts-node run this file directly from .ts source (no compiled .js
// sibling exists yet), so the worker needs ts-node registered to execute the
// same .ts source; the compiled dist build (production) has a real .js
// sibling and needs nothing extra. ts-node is a devDependency only -- the
// production branch below must never require it.
const IS_TS_SOURCE = __filename.endsWith('.ts');
const WORKER_PATH = join(__dirname, IS_TS_SOURCE ? 'pdf-parse.worker.ts' : 'pdf-parse.worker.js');
const WORKER_EXEC_ARGV = IS_TS_SOURCE ? ['-r', 'ts-node/register/transpile-only'] : [];

export async function parsePdfInWorker(pdfBuffer: Buffer): Promise<string> {
  const msg = await runWorker<{ text?: string; error?: string }>(WORKER_PATH, WORKER_EXEC_ARGV, {
    pdfBuffer,
  });
  if (msg.error) throw new Error(msg.error);
  return msg.text ?? '';
}
