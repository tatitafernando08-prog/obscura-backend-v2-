import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '@app/database';
import { GeminiEmbeddingService } from '@app/rag-service/gemini-embedding.service';
import { ChunkUpsertService } from './chunk-upsert.service';

describe('ChunkUpsertService (integration, real dev DB + Gemini)', () => {
  let db: DatabaseService;
  let service: ChunkUpsertService;
  const paperId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, GeminiEmbeddingService, ChunkUpsertService],
    }).compile();
    db = moduleRef.get(DatabaseService);
    service = moduleRef.get(ChunkUpsertService);

    await db.query(
      `insert into papers (id, subject, storage_path, status) values ($1, 'Test', 'test/x.pdf', 'processing')`,
      [paperId],
    );
  });

  afterAll(async () => {
    await db.query('delete from papers where id = $1', [paperId]);
  });

  it('embeds and inserts each chunk, returning the count', async () => {
    const count = await service.upsertChunks(paperId, [
      { content: 'Question 1: State the law of demand.', questionNumber: '1', page: 1 },
      { content: 'Question 2: Define elasticity.', questionNumber: '2', page: 1 },
    ]);

    expect(count).toBe(2);

    const rows = await db.query<{ content: string; chunk_index: number }>(
      'select content, chunk_index from paper_chunks where paper_id = $1 order by chunk_index',
      [paperId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].chunk_index).toBe(0);
    expect(rows[1].chunk_index).toBe(1);
  }, 30000);
});
