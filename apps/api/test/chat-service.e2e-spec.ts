import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Transport, MicroserviceOptions, ClientGrpc, ClientProxyFactory } from '@nestjs/microservices';
import { join } from 'path';
import { firstValueFrom } from 'rxjs';
import { AppModule } from '../src/app.module';
import { ChatLlmServiceClient } from '@app/proto/generated/chat';

describe('Chat/LLM Service (gRPC e2e)', () => {
  let app: INestApplication;
  let client: ChatLlmServiceClient;

  const grpcOptions = {
    transport: Transport.GRPC as const,
    options: {
      package: 'chat',
      protoPath: join(__dirname, '../../../libs/proto/src/chat.proto'),
      url: '127.0.0.1:50063', // distinct test port
      // chat.proto imports rag.proto, so proto-loader needs includeDirs to
      // resolve that import. Also needs arrays:true (see main.ts) since
      // AskRequest/AskResponse both have repeated fields.
      loader: { arrays: true, includeDirs: [join(__dirname, '../../../libs/proto/src')] },
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();

    app.connectMicroservice<MicroserviceOptions>(grpcOptions);
    await app.startAllMicroservices();
    await app.init();

    const grpcClient: ClientGrpc = ClientProxyFactory.create(grpcOptions) as unknown as ClientGrpc;
    client = grpcClient.getService<ChatLlmServiceClient>('ChatLlmService');
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns grounded:true and sources:[] for a small-talk question with zero retrieved chunks', async () => {
    const result = await firstValueFrom(
      client.ask({
        questionText: 'hi there',
        medium: 'english',
        history: [],
        retrievedChunks: [],
      }),
    );
    expect(result.grounded).toBe(true);
    expect(result.sources).toEqual([]);
  }, 30_000);
});
