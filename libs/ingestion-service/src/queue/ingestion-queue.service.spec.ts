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
  }, 20000);

  it(
    'enqueues a job that becomes visible in the queue',
    async () => {
      // Pause the shared live queue for the assertion window: this is the same real
      // Upstash Redis instance a live IngestionServiceModule Worker (Task 56) may be
      // consuming from in another running process, which would otherwise race this
      // test's job into 'active'/'failed' before getWaiting() reads it back. Same
      // pattern as apps/api/test/papers-upload.e2e-spec.ts — must always be resumed.
      await inspectQueue.pause();
      try {
        await service.enqueue({ paperId: 'paper-123' });
        const waiting = await inspectQueue.getWaiting();
        expect(waiting.some((j) => j.data.paperId === 'paper-123')).toBe(true);
      } finally {
        await inspectQueue.resume();
      }
    },
    20000,
  );
});
