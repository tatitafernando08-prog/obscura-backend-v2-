import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CohereClient } from 'cohere-ai';
import { EnvConfig } from '@app/common';
import { CandidateChunk } from './hybrid-search';

export type RankedChunk = CandidateChunk & { relevanceScore: number };

@Injectable()
export class RerankService {
  private readonly client: CohereClient;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = new CohereClient({ token: config.get('COHERE_API_KEY', { infer: true }) });
  }

  async rerank(query: string, candidates: CandidateChunk[], topK: number): Promise<RankedChunk[]> {
    if (candidates.length === 0) return [];

    const response = await this.client.rerank({
      model: 'rerank-v3.5',
      query,
      documents: candidates.map((c) => c.content),
      topN: Math.min(topK, candidates.length),
    });

    return response.results.slice(0, topK).map((result) => ({
      ...candidates[result.index],
      relevanceScore: result.relevanceScore,
    }));
  }
}
