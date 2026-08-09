import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Transport, MicroserviceOptions, ClientGrpc, ClientProxyFactory } from '@nestjs/microservices';
import { join } from 'path';
import { firstValueFrom } from 'rxjs';
import { AppModule } from '../src/app.module';
import { RagServiceClient } from '@app/proto/generated/rag';
import { HybridSearchService } from '@app/rag-service/hybrid-search';
import { RerankService } from '@app/rag-service/rerank.service';

describe('RAG Service (gRPC e2e)', () => {
  let app: INestApplication;
  let client: RagServiceClient;

  const grpcOptions = {
    transport: Transport.GRPC as const,
    options: {
      package: 'rag',
      protoPath: join(__dirname, '../../../libs/proto/src/rag.proto'),
      url: '127.0.0.1:50062', // distinct test port
      // See main.ts: without this, an empty `chunks` repeated field decodes
      // as `undefined` rather than `[]`.
      loader: { arrays: true },
    },
  };

  beforeAll(async () => {
    const mockHybridSearchService = {
      retrieveCandidates: jest.fn().mockResolvedValue([]),
    };
    const mockRerankService = {
      rerank: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(HybridSearchService)
      .useValue(mockHybridSearchService)
      .overrideProvider(RerankService)
      .useValue(mockRerankService)
      .compile();
    app = moduleRef.createNestApplication();

    app.connectMicroservice<MicroserviceOptions>(grpcOptions);
    await app.startAllMicroservices();
    await app.init();

    const grpcClient: ClientGrpc = ClientProxyFactory.create(grpcOptions) as unknown as ClientGrpc;
    client = grpcClient.getService<RagServiceClient>('RagService');
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns an empty chunks array for a query with zero matching chunks', async () => {
    const result = await firstValueFrom(
      client.search({ query: 'no matching content anywhere', subject: '', syllabus: '', level: '', medium: '', topK: 0 }),
    );
    expect(result.chunks).toEqual([]);
  });
});
