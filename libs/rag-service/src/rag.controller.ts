import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { HybridSearchService } from './hybrid-search';
import { RerankService } from './rerank.service';
import { SearchRequest, SearchResponse } from '@app/proto/generated/rag';

const DEFAULT_TOP_K = 5;
const MIN_RELEVANCE_THRESHOLD = 0.3;

@Controller()
export class RagController {
  constructor(
    private readonly hybridSearch: HybridSearchService,
    private readonly rerank: RerankService,
  ) {}

  @GrpcMethod('RagService', 'Search')
  async search(request: SearchRequest): Promise<SearchResponse> {
    const candidates = await this.hybridSearch.retrieveCandidates(request.query, {
      subject: request.subject || undefined,
      syllabus: request.syllabus || undefined,
      level: request.level || undefined,
      medium: request.medium || undefined,
    });

    const ranked = await this.rerank.rerank(
      request.query,
      candidates.slice(0, 20),
      request.topK || DEFAULT_TOP_K,
    );

    const aboveThreshold = ranked.filter((c) => c.relevanceScore >= MIN_RELEVANCE_THRESHOLD);

    return {
      chunks: aboveThreshold.map((c) => ({
        chunkId: c.chunkId,
        paperId: c.paperId,
        content: c.content,
        subject: c.subject,
        year: c.year ?? 0,
        questionNumber: c.questionNumber ?? '',
        page: c.page ?? 0,
        relevanceScore: c.relevanceScore,
      })),
    };
  }
}
