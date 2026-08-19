import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { DatabaseService, DatabaseModule } from '@app/database';
import { GeminiEmbeddingService } from '@app/rag-service';
import { IngestionProcessor } from './ingestion.processor';
import { GeminiExtractor } from './extraction/gemini-extractor';
import { ChunkUpsertService } from './chunk-upsert.service';
import { INGESTION_QUEUE_NAME } from './queue/ingestion-job.types';

describe('IngestionProcessor (integration, real Redis + DB)', () => {
  let db: DatabaseService;
  let processor: IngestionProcessor;
  let queue: Queue;
  const paperId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule],
      providers: [IngestionProcessor, GeminiExtractor, ChunkUpsertService, GeminiEmbeddingService],
    }).compile();
    db = moduleRef.get(DatabaseService);
    processor = moduleRef.get(IngestionProcessor);
    queue = new Queue(INGESTION_QUEUE_NAME, { connection: { url: process.env.REDIS_URL } as any });

    await db.query(
      `insert into papers (id, subject, storage_path, status) values ($1, 'Test Subject', 'test/does-not-matter.pdf', 'processing')`,
      [paperId],
    );
  });

  afterAll(async () => {
    await db.query('delete from papers where id = $1', [paperId]);
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('marks the paper failed if PDF extraction throws (proves the error path updates status, not just the happy path)', async () => {
    // processHatch: with a bogus storage_path, downloadPdf will throw — this test only
    // exercises the processor's error-handling wrapper, not real extraction (that's Task 57+).
    await processor.process({ id: 'job-1', data: { paperId } } as any);

    const rows = await db.query<{ status: string; error_reason: string | null }>(
      'select status, error_reason from papers where id = $1',
      [paperId],
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error_reason).toBeTruthy();
  });
});
