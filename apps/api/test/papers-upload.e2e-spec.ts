import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { Queue } from 'bullmq';
import { join } from 'path';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService, StorageService } from '@app/database';
import { INGESTION_QUEUE_NAME } from '@app/ingestion-service';
import { EnvConfig } from '@app/common';

// Minimal-but-valid single-page PDF. This task never parses the file, only
// stores + enqueues it, so a hand-built near-empty PDF is sufficient.
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 3 3]>>endobj\n' +
    'trailer<</Size 4/Root 1 0 R>>\n' +
    '%%EOF',
  'utf-8',
);

describe('POST /papers/upload (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let storage: StorageService;
  let inspectQueue: Queue;
  const studentId = process.env.TEST_STUDENT_ID!;
  const createdPaperIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    db = moduleRef.get(DatabaseService);
    storage = moduleRef.get(StorageService);
    const config = app.get(ConfigService<EnvConfig, true>);

    // Only the auth gRPC microservice is needed: AuthGuard -> AuthService is
    // the only downstream dependency PapersUploadController pulls in (same
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

    inspectQueue = new Queue(INGESTION_QUEUE_NAME, { connection: { url: config.get('REDIS_URL', { infer: true }) } as any });
  });

  afterAll(async () => {
    // Restore the shared fixture's role so other tests aren't affected.
    await db.query(`update students set role = 'student' where id = $1`, [studentId]);

    // Clean up rows/objects/jobs created by this spec so repeat runs stay idempotent.
    for (const paperId of createdPaperIds) {
      const rows = await db.query<{ storage_path: string }>(
        `select storage_path from papers where id = $1`,
        [paperId],
      );
      if (rows[0]) {
        await storage.deletePdf(rows[0].storage_path).catch(() => undefined);
      }
      await db.query(`delete from papers where id = $1`, [paperId]);

      const waiting = await inspectQueue.getWaiting();
      const job = waiting.find((j) => j.data.paperId === paperId);
      if (job) await job.remove();
    }

    await inspectQueue.close();
    await app.close();
  });

  it('rejects a non-admin JWT with 403', async () => {
    const token = process.env.TEST_STUDENT_JWT!; // set locally before running this test
    await request(app.getHttpServer())
      .post('/papers/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('subject', 'Economics')
      .attach('file', TINY_PDF, { filename: 'paper.pdf', contentType: 'application/pdf' })
      .expect(403);
  });

  it('stores the PDF, inserts a processing paper row, and enqueues an ingestion job for an admin JWT', async () => {
    const token = process.env.TEST_STUDENT_JWT!; // same fixture, promoted to admin below
    await db.query(`update students set role = 'admin' where id = $1`, [studentId]);

    const res = await request(app.getHttpServer())
      .post('/papers/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('subject', 'Economics')
      .field('year', '2023')
      .field('syllabus', 'local')
      .field('level', 'al')
      .field('medium', 'english')
      .attach('file', TINY_PDF, { filename: 'paper.pdf', contentType: 'application/pdf' })
      .expect(201);

    expect(res.body).toEqual({ paper_id: expect.any(String), status: 'processing' });
    createdPaperIds.push(res.body.paper_id);

    const rows = await db.query<{ status: string; subject: string; storage_path: string; uploaded_by: string }>(
      `select status, subject, storage_path, uploaded_by from papers where id = $1`,
      [res.body.paper_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('processing');
    expect(rows[0].subject).toBe('Economics');
    expect(rows[0].uploaded_by).toBe(studentId);

    const waiting = await inspectQueue.getWaiting();
    expect(waiting.some((j) => j.data.paperId === res.body.paper_id)).toBe(true);
  });

  it('rejects a non-PDF file with 400', async () => {
    const token = process.env.TEST_STUDENT_JWT!; // fixture is still admin from the previous test
    await request(app.getHttpServer())
      .post('/papers/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('subject', 'Economics')
      .attach('file', Buffer.from('not a pdf'), { filename: 'notes.txt', contentType: 'text/plain' })
      .expect(400);
  });

  it("rejects a file over the 25MB limit with 400, via multer's stream-level cap (not a 500/hang)", async () => {
    const token = process.env.TEST_STUDENT_JWT!; // fixture is still admin from the previous test
    // One byte over the controller's MAX_SIZE_BYTES (25 * 1024 * 1024). This
    // exercises FileInterceptor's `limits.fileSize` (multer aborts the
    // upload stream before it's ever fully buffered), not the controller
    // body's post-buffering `file.size` backstop check.
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);

    const res = await request(app.getHttpServer())
      .post('/papers/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('subject', 'Economics')
      .attach('file', oversized, { filename: 'huge.pdf', contentType: 'application/pdf' })
      .expect(400);

    expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  }, 30_000);
});
