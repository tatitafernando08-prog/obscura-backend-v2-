import { RealtimeGateway } from './realtime.gateway';

describe('RealtimeGateway', () => {
  it('emits paper:ingestion_status on the server with the given payload', () => {
    const gateway = new RealtimeGateway();
    gateway.server = { emit: jest.fn() } as any;

    gateway.emitIngestionStatus({ paper_id: 'p1', status: 'ready', chunk_count: 5 });

    expect(gateway.server.emit).toHaveBeenCalledWith('paper:ingestion_status', {
      paper_id: 'p1',
      status: 'ready',
      chunk_count: 5,
    });
  });
});
