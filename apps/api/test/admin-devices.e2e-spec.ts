import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { join } from 'path';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '@app/database';
import { EnvConfig } from '@app/common';

describe('POST /admin/devices (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  const studentId = process.env.TEST_STUDENT_ID!;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    db = moduleRef.get(DatabaseService);
    const config = app.get(ConfigService<EnvConfig, true>);

    // Only the auth gRPC microservice is needed here: AuthGuard -> AuthService
    // is the only downstream dependency AdminDevicesController pulls in
    // (unlike chat-ask.e2e-spec.ts, which also needs rag/chat).
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
    // Restore the shared fixture's role so other tests aren't affected.
    await db.query(`update students set role = 'student' where id = $1`, [studentId]);
    await app.close();
  });

  it('rejects a non-admin JWT with 403', async () => {
    // Requires: e2e-test-student@obscura.test's real JWT (see chat-ask.e2e-spec.ts
    // for the fixture) with its default role='student'.
    const token = process.env.TEST_STUDENT_JWT!; // set locally before running this test
    await request(app.getHttpServer())
      .post('/admin/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'e2e non-admin attempt' })
      .expect(403);
  });

  it('provisions a device for an admin JWT, returning device_id and a plaintext api_key', async () => {
    const token = process.env.TEST_STUDENT_JWT!; // same fixture, promoted to admin below
    await db.query(`update students set role = 'admin' where id = $1`, [studentId]);

    const res = await request(app.getHttpServer())
      .post('/admin/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'e2e provisioned device' })
      .expect(201);

    expect(res.body).toHaveProperty('device_id');
    expect(res.body.api_key).toMatch(/^[0-9a-f]{48}$/);

    await db.query('delete from devices where id = $1', [res.body.device_id]); // cleanup
  });
});
