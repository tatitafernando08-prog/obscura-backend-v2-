import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { EnvConfig } from '@app/common';
import { IngestionProcessor } from './ingestion.processor';
import { IngestionQueueModule } from './queue/ingestion-queue.module';
import { INGESTION_QUEUE_NAME } from './queue/ingestion-job.types';

@Module({
  imports: [IngestionQueueModule],
  providers: [IngestionProcessor],
  exports: [IngestionProcessor],
})
export class IngestionServiceModule implements OnModuleInit {
  private worker: Worker;

  constructor(private readonly processor: IngestionProcessor, private readonly config: ConfigService<EnvConfig, true>) {}

  onModuleInit(): void {
    this.worker = new Worker(
      INGESTION_QUEUE_NAME,
      (job) => this.processor.process(job),
      { connection: { url: this.config.get('REDIS_URL', { infer: true }) } as any },
    );
  }
}
