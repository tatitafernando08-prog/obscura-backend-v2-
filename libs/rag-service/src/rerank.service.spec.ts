import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { RerankService } from './rerank.service';
import { CandidateChunk } from './hybrid-search';

const mockRerank = jest.fn();
jest.mock('cohere-ai', () => ({
  CohereClient: jest.fn().mockImplementation(() => ({ rerank: mockRerank })),
}));

describe('RerankService', () => {
  let service: RerankService;

  const candidates: CandidateChunk[] = [
    { chunkId: 'a', paperId: 'p1', content: 'irrelevant text about photosynthesis', subject: 'Biology', year: 2021, questionNumber: null, page: null },
    { chunkId: 'b', paperId: 'p1', content: 'the law of demand and price elasticity', subject: 'Economics', year: 2022, questionNumber: null, page: null },
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [RerankService],
    }).compile();
    service = moduleRef.get(RerankService);
  });

  it('reorders candidates by Cohere relevance score, highest first', async () => {
    mockRerank.mockResolvedValue({
      results: [
        { index: 1, relevanceScore: 0.91 }, // candidate 'b'
        { index: 0, relevanceScore: 0.12 }, // candidate 'a'
      ],
    });

    const ranked = await service.rerank('what happens to demand when price rises?', candidates, 5);

    expect(ranked[0].chunkId).toBe('b');
    expect(ranked[0].relevanceScore).toBeCloseTo(0.91);
    expect(ranked[1].chunkId).toBe('a');
  });

  it('truncates to topK', async () => {
    mockRerank.mockResolvedValue({
      results: [
        { index: 0, relevanceScore: 0.5 },
        { index: 1, relevanceScore: 0.9 },
      ],
    });
    const ranked = await service.rerank('query', candidates, 1);
    expect(ranked).toHaveLength(1);
  });
});
