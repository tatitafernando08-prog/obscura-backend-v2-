import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Queue } from 'bullmq';
import { IngestionQueueService } from './ingestion-queue.service';
import { INGESTION_QUEUE_NAME } from './ingestion-job.types';

describe('IngestionQueueService (integration, real Redis)', () => {
  let service: IngestionQueueService;
  let inspectQueue: Queue;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [IngestionQueueService],
    }).compile();
    service = moduleRef.get(IngestionQueueService);
    inspectQueue = new Queue(INGESTION_QUEUE_NAME, { connection: { url: process.env.REDIS_URL } as any });
  });

  afterAll(async () => {
    await inspectQueue.obliterate({ force: true });
    await inspectQueue.close();
    await service.onModuleDestroy();
  });

  it('enqueues a job that becomes visible in the queue', async () => {
    await service.enqueue({ paperId: 'paper-123' });
    const waiting = await inspectQueue.getWaiting();
    expect(waiting.some((j) => j.data.paperId === 'paper-123')).toBe(true);
  });
});
