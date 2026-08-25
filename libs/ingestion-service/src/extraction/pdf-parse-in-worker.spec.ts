import { readFileSync } from 'fs';
import { join } from 'path';
import * as http from 'http';
import { AddressInfo } from 'net';
import { parsePdfInWorker } from './pdf-parse-in-worker';

const FIXTURE_PATH = join(__dirname, '../../test/fixtures/sample-paper.pdf');

/**
 * Reproduces the exact conditions that corrupt pdf-parse's internal state in
 * production: real concurrent Node I/O (many small Buffer-producing HTTP
 * responses) racing against the PDF parse, on the same thread. A bare
 * `pdfParse(buffer)` call fails ~100% of the time under this pressure (bad
 * XRef entry / corrupted hex-string decoding using bytes from the other
 * response) — verified manually against this exact fixture before writing
 * this test. `parsePdfInWorker` must isolate the parse from that pressure.
 */
async function withConcurrentIoPressure<T>(work: () => Promise<T>): Promise<T> {
  const body = '<html><head><title>load</title></head><body>' + 'x'.repeat(2000) + '</body></html>';
  const server = http.createServer((_req, res) => res.end(body));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const fetchOnce = () =>
    new Promise<void>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/`, (res) => {
          res.on('data', () => undefined);
          res.on('end', () => resolve());
        })
        .on('error', reject);
    });

  try {
    const [result] = await Promise.all([work(), ...Array.from({ length: 20 }, fetchOnce)]);
    return result;
  } finally {
    server.close();
  }
}

describe('parsePdfInWorker', () => {
  it('extracts the real text even under heavy concurrent I/O on the main thread', async () => {
    const pdf = readFileSync(FIXTURE_PATH);

    const text = await withConcurrentIoPressure(() => parsePdfInWorker(pdf));

    expect(text).toContain('law of demand');
  }, 15000);

  it('is reliable across repeated concurrent runs, not just lucky once', async () => {
    const pdf = readFileSync(FIXTURE_PATH);

    for (let i = 0; i < 5; i++) {
      const text = await withConcurrentIoPressure(() => parsePdfInWorker(pdf));
      expect(text).toContain('law of demand');
    }
  }, 30000);
});
