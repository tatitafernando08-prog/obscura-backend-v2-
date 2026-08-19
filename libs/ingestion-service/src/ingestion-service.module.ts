import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { EnvConfig } from '@app/common';
// Deep import (not the `@app/gateway` barrel) — see the comment in
// `ingestion.processor.ts` and `realtime.module.ts` for why: going through
// `@app/gateway`'s index.ts here would circularly require this lib's own
// index.ts (which `gateway.module.ts` imports for `IngestionQueueModule`).
import { RealtimeModule } from '@app/gateway/realtime/realtime.module';
import { IngestionProcessor } from './ingestion.processor';
import { IngestionQueueModule } from './queue/ingestion-queue.module';
import { INGESTION_QUEUE_NAME } from './queue/ingestion-job.types';
import { GeminiExtractor } from './extraction/gemini-extractor';
import { ChunkUpsertService } from './chunk-upsert.service';
import { GeminiEmbeddingService } from '@app/rag-service';

@Module({
  imports: [IngestionQueueModule, RealtimeModule],
  providers: [IngestionProcessor, GeminiExtractor, ChunkUpsertService, GeminiEmbeddingService],
  exports: [IngestionProcessor],
})
export class IngestionServiceModule implements OnModuleInit, OnModuleDestroy {
  private worker: Worker | null = null;

  constructor(private readonly processor: IngestionProcessor, private readonly config: ConfigService<EnvConfig, true>) {}

  onModuleInit(): void {
    this.worker = new Worker(
      INGESTION_QUEUE_NAME,
      (job) => this.processor.process(job),
      { connection: { url: this.config.get('REDIS_URL', { infer: true }) } as any },
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
