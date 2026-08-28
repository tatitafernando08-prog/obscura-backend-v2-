import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import {
  Transport,
  MicroserviceOptions,
  ClientGrpc,
  ClientProxyFactory,
} from '@nestjs/microservices';
import { join } from 'path';
import { firstValueFrom } from 'rxjs';
import { AppModule } from '../src/app.module';
import { SpeechServiceClient } from '@app/proto/generated/speech';

describe('Speech Service (gRPC e2e)', () => {
  let app: INestApplication;
  let client: SpeechServiceClient;

  const grpcOptions = {
    transport: Transport.GRPC as const,
    options: {
      package: 'speech',
      protoPath: join(__dirname, '../../../libs/proto/src/speech.proto'),
      url: '127.0.0.1:50064', // distinct test port
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();

    app.connectMicroservice<MicroserviceOptions>(grpcOptions);
    await app.startAllMicroservices();
    await app.init();

    const grpcClient: ClientGrpc = ClientProxyFactory.create(
      grpcOptions,
    ) as unknown as ClientGrpc;
    client = grpcClient.getService<SpeechServiceClient>('SpeechService');
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns success:false with sinhala_not_supported_on_voice for a sinhala Transcribe request', async () => {
    const result = await firstValueFrom(
      client.transcribe({ wavAudio: new Uint8Array(0), medium: 'sinhala' }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('sinhala_not_supported_on_voice');
  });
});
