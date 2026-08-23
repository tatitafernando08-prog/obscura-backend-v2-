import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { join } from 'path';
import * as request from 'supertest';
import { readFileSync } from 'fs';
import { AppModule } from '../src/app.module';
import { EnvConfig } from '@app/common';

describe('POST /voice/ask (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    const config = app.get(ConfigService<EnvConfig, true>);

    // VoiceController's dependency chain touches every gRPC microservice in
    // the app (DeviceAuthGuard -> auth, GatewayAskService -> rag + chat,
    // VoiceController itself -> speech). Mirrors chat-ask.e2e-spec.ts: since
    // no separate dev server is running, this single test process must also
    // serve all four at their fixed configured ports for the real end-to-end
    // request flow to succeed.
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        package: 'auth',
        protoPath: join(__dirname, '../../../libs/proto/src/auth.proto'),
        url: config.get('AUTH_GRPC_URL', { infer: true }),
      },
    });

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        package: 'rag',
        protoPath: join(__dirname, '../../../libs/proto/src/rag.proto'),
        url: config.get('RAG_GRPC_URL', { infer: true }),
        loader: { arrays: true },
      },
    });

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        package: 'chat',
        protoPath: join(__dirname, '../../../libs/proto/src/chat.proto'),
        url: config.get('CHAT_GRPC_URL', { infer: true }),
        loader: { arrays: true, includeDirs: [join(__dirname, '../../../libs/proto/src')] },
      },
    });

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        package: 'speech',
        protoPath: join(__dirname, '../../../libs/proto/src/speech.proto'),
        url: config.get('SPEECH_GRPC_URL', { infer: true }),
      },
    });

    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.startAllMicroservices();
    await app.init();
  });

  afterAll(async () => app.close());

  it('rejects requests with no X-Device-Key header', async () => {
    await request(app.getHttpServer())
      .post('/voice/ask?medium=english')
      .attach('audio', Buffer.from('fake'), 'mic.wav')
      .expect(401);
  });

  it('returns raw PCM for a valid device key and a real WAV fixture', async () => {
    // Requires: a device provisioned via Task 44's endpoint, key exported as
    // TEST_DEVICE_KEY; the real WAV fixture at
    // apps/api/test/fixtures/sample-question.wav (16kHz mono 16-bit, genuine
    // synthesized speech saying "What is the law of demand?").
    const wavPath = join(__dirname, 'fixtures/sample-question.wav');
    const res = await request(app.getHttpServer())
      .post('/voice/ask?subject=Economics&medium=english')
      .set('X-Device-Key', process.env.TEST_DEVICE_KEY!)
      .attach('audio', readFileSync(wavPath), 'mic.wav')
      .expect(200);

    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.body.length).toBeGreaterThan(0);
  }, 30_000);
});
