import { Module } from '@nestjs/common';
import { IngestionQueueService } from './ingestion-queue.service';

@Module({
  providers: [IngestionQueueService],
  exports: [IngestionQueueService],
})
export class IngestionQueueModule {}
