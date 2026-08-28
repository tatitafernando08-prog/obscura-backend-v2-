import { IngestionProcessor } from './ingestion.processor';

/**
 * Pure-unit coverage (all collaborators mocked, no real DB/Redis/Gemini) for
 * the WS-emit isolation fixed after Task 61's review: a throwing
 * `RealtimeGateway.emitIngestionStatus` must never flip a successful
 * ingestion to `'failed'`, and must never escape `process()` as an unhandled
 * rejection on the failure path either. Kept separate from
 * `ingestion.processor.spec.ts` (which needs real DB/Redis/Gemini and is
 * currently blocked by Gemini quota exhaustion) so this fix is verifiable
 * independent of that environmental issue.
 */
describe('IngestionProcessor — WS emit isolation', () => {
  const paperId = 'paper-1';

  function buildProcessor(emitIngestionStatus: jest.Mock) {
    const db = { query: jest.fn().mockResolvedValue([{ storage_path: 'test/path.pdf' }]) };
    const storage = { downloadPdf: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')) };
    const geminiExtractor = {
      extractChunks: jest.fn().mockResolvedValue([{ content: 'Q1', page: 1 }]),
    };
    const chunkUpsert = { upsertChunks: jest.fn().mockResolvedValue(1) };
    const realtimeGateway = { emitIngestionStatus };

    const processor = new IngestionProcessor(
      db as any,
      storage as any,
      geminiExtractor as any,
      chunkUpsert as any,
      realtimeGateway as any,
    );

    return { processor, db, storage, geminiExtractor, chunkUpsert };
  }

  it('does not flip a successful ingestion to failed when emitIngestionStatus throws', async () => {
    const emitIngestionStatus = jest.fn().mockImplementation(() => {
      throw new Error('socket.io internal error');
    });
    const { processor, db } = buildProcessor(emitIngestionStatus);

    const result = await processor.process({ data: { paperId } } as any);

    expect(result).toEqual({ status: 'ready', chunkCount: 1 });
    // The DB was written 'ready' exactly once — never overwritten to 'failed'
    // by the (isolated) emit throw.
    const statusUpdateCalls = db.query.mock.calls.filter(([sql]: [string]) => /^update papers set status/.test(sql));
    expect(statusUpdateCalls).toEqual([[`update papers set status = 'ready' where id = $1`, [paperId]]]);
    expect(emitIngestionStatus).toHaveBeenCalledWith({ paper_id: paperId, status: 'ready', chunk_count: 1 });
  });

  it('does not escape process() when the failure-path emitIngestionStatus throws', async () => {
    const emitIngestionStatus = jest.fn().mockImplementation(() => {
      throw new Error('socket.io internal error');
    });
    const { processor, db, storage } = buildProcessor(emitIngestionStatus);
    storage.downloadPdf.mockRejectedValue(new Error('download failed'));

    await expect(processor.process({ data: { paperId } } as any)).resolves.toEqual({ status: 'failed' });

    const statusUpdateCalls = db.query.mock.calls.filter(([sql]: [string]) => /^update papers set status/.test(sql));
    expect(statusUpdateCalls).toHaveLength(1);
    expect(statusUpdateCalls[0][0]).toContain(`status = 'failed'`);
    expect(emitIngestionStatus).toHaveBeenCalledWith({ paper_id: paperId, status: 'failed' });
  });
});
