import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '@app/database';
import { HybridSearchService } from './hybrid-search';
import { GeminiEmbeddingService } from './gemini-embedding.service';

describe('HybridSearchService (integration, real dev DB)', () => {
  let db: DatabaseService;
  let embeddings: GeminiEmbeddingService;
  let service: HybridSearchService;
  const paperId = randomUUID();
  const chunkIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, GeminiEmbeddingService, HybridSearchService],
    }).compile();
    db = moduleRef.get(DatabaseService);
    embeddings = moduleRef.get(GeminiEmbeddingService);
    service = moduleRef.get(HybridSearchService);

    await db.query(
      `insert into papers (id, subject, year, syllabus, level, medium, storage_path, status)
       values ($1, 'Economics', 2022, 'local', 'al', 'english', 'test/path.pdf', 'ready')`,
      [paperId],
    );

    const contents = [
      'The law of demand states that as price increases, quantity demanded decreases, ceteris paribus.',
      'Photosynthesis converts light energy into chemical energy stored in glucose.',
    ];
    for (const [i, content] of contents.entries()) {
      const embedding = await embeddings.embed(content, 'RETRIEVAL_DOCUMENT');
      const rows = await db.query<{ id: string }>(
        `insert into paper_chunks (paper_id, chunk_index, content, embedding)
         values ($1, $2, $3, $4::vector) returning id`,
        [paperId, i, content, `[${embedding.join(',')}]`],
      );
      chunkIds.push(rows[0].id);
    }
  }, 60000);

  afterAll(async () => {
    await db.query('delete from papers where id = $1', [paperId]); // cascades to paper_chunks
  }, 15000);

  it('returns the economics chunk as a top candidate for an economics-shaped query, not the biology chunk', async () => {
    const candidates = await service.retrieveCandidates('What happens to demand when price goes up?', {});
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].content).toContain('law of demand');
  }, 30000);

  it('applies subject filtering', async () => {
    const candidates = await service.retrieveCandidates('law of demand', { subject: 'Economics' });
    expect(candidates.every((c) => c.subject === 'Economics')).toBe(true);

    const noneMatch = await service.retrieveCandidates('law of demand', { subject: 'Physics' });
    expect(noneMatch).toHaveLength(0);
  }, 30000);

  it('caps fused results to top ~20 candidates per Task 20 interface contract', async () => {
    const candidates = await service.retrieveCandidates('law of demand', {});
    expect(candidates.length).toBeLessThanOrEqual(20);
  }, 30000);
});
