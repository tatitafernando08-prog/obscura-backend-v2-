import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { EnvConfig } from '@app/common';
import { IngestionProcessor } from './ingestion.processor';
import { IngestionQueueModule } from './queue/ingestion-queue.module';
import { INGESTION_QUEUE_NAME } from './queue/ingestion-job.types';
import { GeminiExtractor } from './extraction/gemini-extractor';

@Module({
  imports: [IngestionQueueModule],
  providers: [IngestionProcessor, GeminiExtractor],
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
