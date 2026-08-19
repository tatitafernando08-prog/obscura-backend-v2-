import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { join } from 'path';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '@app/database';
import { EnvConfig } from '@app/common';

describe('GET /papers and GET /papers/:id (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    db = moduleRef.get(DatabaseService);
    const config = app.get(ConfigService<EnvConfig, true>);

    // Only the auth gRPC microservice is needed: AuthGuard -> AuthService is
    // the only downstream dependency PapersController pulls in (same
    // reasoning as admin-devices.e2e-spec.ts).
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        package: 'auth',
        protoPath: join(__dirname, '../../../libs/proto/src/auth.proto'),
        url: config.get('AUTH_GRPC_URL', { infer: true }),
      },
    });

    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.startAllMicroservices();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with a papers array (using Task 23-seeded papers)', async () => {
    const token = process.env.TEST_STUDENT_JWT!; // set locally before running this test
    const res = await request(app.getHttpServer())
      .get('/papers')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(res.body.papers)).toBe(true);
    expect(res.body.papers.length).toBeGreaterThan(0);
  });

  it('returns 404 for a bogus (well-formed but non-existent) UUID', async () => {
    const token = process.env.TEST_STUDENT_JWT!; // set locally before running this test
    await request(app.getHttpServer())
      .get('/papers/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('returns 200 with the expected shape including chunk_count for a real seeded paper id', async () => {
    const token = process.env.TEST_STUDENT_JWT!; // set locally before running this test

    // Query a real, currently-existing paper id at test time rather than
    // hardcoding one, so this doesn't depend on a specific seed run's UUIDs.
    const rows = await db.query<{ id: string }>('select id from papers limit 1');
    expect(rows.length).toBeGreaterThan(0);
    const paperId = rows[0].id;

    const res = await request(app.getHttpServer())
      .get(`/papers/${paperId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toMatchObject({
      paper_id: paperId,
      subject: expect.any(String),
      status: expect.any(String),
      // count(*) is postgres bigint; node-postgres returns it unparsed as a
      // numeric string (not a JS number) to avoid precision loss.
      chunk_count: expect.stringMatching(/^\d+$/),
    });
  });
});
