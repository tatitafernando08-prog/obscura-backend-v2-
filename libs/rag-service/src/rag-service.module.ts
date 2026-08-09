import { Module } from '@nestjs/common';
import { RagController } from './rag.controller';
import { HybridSearchService } from './hybrid-search';
import { RerankService } from './rerank.service';
import { GeminiEmbeddingService } from './gemini-embedding.service';

@Module({
  controllers: [RagController],
  providers: [HybridSearchService, RerankService, GeminiEmbeddingService],
})
export class RagServiceModule {}
