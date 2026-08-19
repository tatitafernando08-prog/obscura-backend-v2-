import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Queue } from 'bullmq';
import { DatabaseService, DatabaseModule, StorageService } from '@app/database';
import { GeminiEmbeddingService } from '@app/rag-service';
import { IngestionProcessor } from './ingestion.processor';
import { GeminiExtractor } from './extraction/gemini-extractor';
import { ChunkUpsertService } from './chunk-upsert.service';
import { INGESTION_QUEUE_NAME } from './queue/ingestion-job.types';

describe('IngestionProcessor (integration, real Redis + DB)', () => {
  let db: DatabaseService;
  let storage: StorageService;
  let processor: IngestionProcessor;
  let queue: Queue;
  const paperId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
      providers: [IngestionProcessor, GeminiExtractor, ChunkUpsertService, GeminiEmbeddingService],
    }).compile();
    db = moduleRef.get(DatabaseService);
    storage = moduleRef.get(StorageService);
    processor = moduleRef.get(IngestionProcessor);
    queue = new Queue(INGESTION_QUEUE_NAME, { connection: { url: process.env.REDIS_URL } as any });

    await db.query(
      `insert into papers (id, subject, storage_path, status) values ($1, 'Test Subject', 'test/does-not-matter.pdf', 'processing')`,
      [paperId],
    );
  }, 30000);

  afterAll(async () => {
    await db.query('delete from papers where id = $1', [paperId]);
    await queue.obliterate({ force: true });
    await queue.close();
  }, 30000);

  it('marks the paper failed if PDF extraction throws (proves the error path updates status, not just the happy path)', async () => {
    // processHatch: with a bogus storage_path, downloadPdf will throw — this test only
    // exercises the processor's error-handling wrapper, not real extraction (that's Task 57+).
    const result = await processor.process({ id: 'job-1', data: { paperId } } as any);

    expect(result.status).toBe('failed');
    expect(result.chunkCount).toBeUndefined();

    const rows = await db.query<{ status: string; error_reason: string | null }>(
      'select status, error_reason from papers where id = $1',
      [paperId],
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_reason).toBeTruthy();
  });

  it('marks the paper ready with a chunk count on successful extraction + upsert', async () => {
    const readyPaperId = randomUUID();
    const realPath = `test/${randomUUID()}.pdf`;
    const pdf = readFileSync(join(__dirname, '../test/fixtures/sample-paper.pdf'));

    await storage.uploadPdf(realPath, pdf);
    await db.query(
      `insert into papers (id, subject, storage_path, status) values ($1, 'Test Subject', $2, 'processing')`,
      [readyPaperId, realPath],
    );

    try {
      const result = await processor.process({ id: 'job-2', data: { paperId: readyPaperId } } as any);

      expect(result.status).toBe('ready');
      expect(result.chunkCount).toBeGreaterThan(0);

      const rows = await db.query<{ status: string }>('select status from papers where id = $1', [
        readyPaperId,
      ]);
      expect(rows[0].status).toBe('ready');

      const chunkRows = await db.query<{ id: string }>(
        'select id from paper_chunks where paper_id = $1',
        [readyPaperId],
      );
      expect(chunkRows.length).toBe(result.chunkCount);
    } finally {
      await db.query('delete from papers where id = $1', [readyPaperId]);
      await storage.deletePdf(realPath);
    }
  }, 60000);
});
