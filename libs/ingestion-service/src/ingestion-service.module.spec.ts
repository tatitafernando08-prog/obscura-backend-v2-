import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { EnvConfig } from '@app/common';
import { IngestionServiceModule } from './ingestion-service.module';
import { IngestionProcessor } from './ingestion.processor';

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({ close: jest.fn() })),
}));

describe('IngestionServiceModule', () => {
  const processor = {} as IngestionProcessor;

  beforeEach(() => {
    (Worker as unknown as jest.Mock).mockClear();
  });

  function configWith(ingestionWorkerEnabled: boolean): ConfigService<EnvConfig, true> {
    return {
      get: (key: string) => (key === 'INGESTION_WORKER_ENABLED' ? ingestionWorkerEnabled : 'redis://unused'),
    } as unknown as ConfigService<EnvConfig, true>;
  }

  it('starts the BullMQ worker when INGESTION_WORKER_ENABLED is true (default)', () => {
    const module = new IngestionServiceModule(processor, configWith(true));
    module.onModuleInit();
    expect(Worker).toHaveBeenCalledTimes(1);
  });

  it('does not start the BullMQ worker when INGESTION_WORKER_ENABLED is false', () => {
    const module = new IngestionServiceModule(processor, configWith(false));
    module.onModuleInit();
    expect(Worker).not.toHaveBeenCalled();
  });

  it('onModuleDestroy is a no-op when the worker was never started', async () => {
    const module = new IngestionServiceModule(processor, configWith(false));
    module.onModuleInit();
    await expect(module.onModuleDestroy()).resolves.toBeUndefined();
  });
});
