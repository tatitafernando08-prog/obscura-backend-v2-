import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { EnvConfig } from '@app/common';
import { IngestionJobPayload, INGESTION_QUEUE_NAME } from './ingestion-job.types';

@Injectable()
export class IngestionQueueService implements OnModuleDestroy {
  private readonly queue: Queue<IngestionJobPayload>;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.queue = new Queue(INGESTION_QUEUE_NAME, {
      connection: { url: config.get('REDIS_URL', { infer: true }) } as any,
    });
  }

  async enqueue(payload: IngestionJobPayload): Promise<void> {
    await this.queue.add('ingest', payload, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
