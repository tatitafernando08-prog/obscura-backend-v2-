import { isMainThread, parentPort, workerData } from 'worker_threads';
// pdf-parse uses `export =` (CommonJS) and this project's tsconfig doesn't set
// esModuleInterop, matching the same import pattern already used elsewhere
// (e.g. ingestion.processor.ts).
import pdfParse = require('pdf-parse');

interface WorkerInput {
  pdfBuffer: Buffer;
}

async function main(): Promise<void> {
  const { pdfBuffer } = workerData as WorkerInput;
  try {
    const parsed = await pdfParse(pdfBuffer);
    parentPort!.postMessage({ text: parsed.text });
  } catch (err) {
    parentPort!.postMessage({ error: (err as Error).message });
  }
}

// `pdf-parse-in-worker.ts` imports this file (for its side effect below) purely
// so tsc's import-reachability analysis includes it in the compiled dist
// output -- it's only ever loaded as a real Worker entry point at runtime
// (via a `join(__dirname, ...)` string path, which tsc can't statically see).
// Guard against running the actual parse when merely `require`d on the main
// thread by that import.
if (!isMainThread) {
  void main();
}
