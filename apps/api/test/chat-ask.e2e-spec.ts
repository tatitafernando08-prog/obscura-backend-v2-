import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { join } from 'path';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { EnvConfig } from '@app/common';

describe('POST /chat/ask (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    const config = app.get(ConfigService<EnvConfig, true>);

    // The gateway's gRPC client providers (Task 29) dial the fixed
    // AUTH_GRPC_URL/RAG_GRPC_URL/CHAT_GRPC_URL addresses from config, mirroring
    // production's apps/api/src/main.ts. Unlike the other e2e specs (which bind
    // their server-side microservice to a *distinct* test port to avoid
    // colliding with a real dev instance), the HTTP controller under test here
    // calls out through those same fixed-port client providers, so this single
    // test process must also be the one serving auth/rag/chat gRPC on exactly
    // those ports for the real request flow (AuthGuard -> auth, then
    // GatewayAskService -> rag -> chat) to succeed end-to-end.
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

    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.startAllMicroservices();
    await app.init();
  });

  afterAll(async () => app.close());

  it('rejects requests with no Authorization header', async () => {
    await request(app.getHttpServer())
      .post('/chat/ask')
      .send({ question: 'hi', medium: 'english', student_id: 'x' })
      .expect(401);
  });

  it('returns the mobile app wire contract shape for a seeded curriculum question', async () => {
    // Requires: a real student row + valid JWT for it (see task-31-brief.md's
    // provisioned test credentials), and the Task 23 seed script already run.
    const token = process.env.TEST_STUDENT_JWT!; // set locally before running this test
    const res = await request(app.getHttpServer())
      .post('/chat/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({
        question: 'What happens to demand when price rises?',
        subject: 'Economics',
        syllabus: 'local',
        medium: 'english',
        student_id: process.env.TEST_STUDENT_ID!,
        chat_history: [],
      })
      .expect(200);

    expect(res.body).toHaveProperty('answer');
    expect(Array.isArray(res.body.sources)).toBe(true);
    if (res.body.sources.length > 0) {
      expect(res.body.sources[0]).toHaveProperty('past_papers.subject');
      expect(res.body.sources[0]).toHaveProperty('past_papers.year');
    }
  }, 30_000);
});
