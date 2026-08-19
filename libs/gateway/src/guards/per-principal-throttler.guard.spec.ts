import {
  Controller,
  Get,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Throttle, ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { PerPrincipalThrottlerGuard } from './per-principal-throttler.guard';

describe('PerPrincipalThrottlerGuard.getTracker', () => {
  // Constructor args aren't exercised by getTracker itself; stub them out.
  const guard = new PerPrincipalThrottlerGuard({} as any, {} as any, {} as any);
  const getTracker = (guard as any).getTracker.bind(guard);

  it('tracks by request.principal.id when a principal is present', async () => {
    const tracker = await getTracker({
      principal: { id: 'admin-1' },
      ip: '1.2.3.4',
    });
    expect(tracker).toBe('admin-1');
  });

  it('falls back to req.ip when no principal is present', async () => {
    const tracker = await getTracker({ ip: '1.2.3.4' });
    expect(tracker).toBe('1.2.3.4');
  });

  it('distinguishes two different admins even when nothing else differs', async () => {
    const trackerA = await getTracker({
      principal: { id: 'admin-a' },
      ip: '9.9.9.9',
    });
    const trackerB = await getTracker({
      principal: { id: 'admin-b' },
      ip: '9.9.9.9',
    });
    expect(trackerA).not.toBe(trackerB);
  });
});

/**
 * Proves the guard actually enforces a per-principal cap end-to-end (real
 * ThrottlerGuard + in-memory storage, real HTTP via supertest), not just
 * that getTracker returns the right string. A tiny standalone app is used
 * instead of the full AppModule so this stays fast and needs no DB, Redis,
 * gRPC auth service, or a minted JWT: a test-only middleware stands in for
 * AuthGuard by copying an `x-test-principal-id` header onto
 * `request.principal`, which is all PerPrincipalThrottlerGuard reads.
 */
describe('PerPrincipalThrottlerGuard (integration, real ThrottlerGuard + in-memory storage)', () => {
  @Injectable()
  class FakePrincipalMiddleware implements NestMiddleware {
    use(req: any, _res: any, next: () => void) {
      const id = req.headers['x-test-principal-id'];
      if (id) req.principal = { id, role: 'admin', type: 'student' };
      next();
    }
  }

  @Controller('test')
  class PingController {
    @Get('ping')
    @Throttle({ default: { limit: 2, ttl: 60_000 } }) // deliberately tiny for a fast, deterministic test
    @UseGuards(PerPrincipalThrottlerGuard)
    ping() {
      return { ok: true };
    }
  }

  @Module({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }])],
    controllers: [PingController],
  })
  class TestAppModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(FakePrincipalMiddleware).forRoutes(PingController);
    }
  }

  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows requests up to the limit, then returns 429 for the same principal', async () => {
    const server = app.getHttpServer();

    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-limit-test')
      .expect(200);
    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-limit-test')
      .expect(200);
    const res = await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-limit-test')
      .expect(429);

    expect(res.body).toMatchObject({ statusCode: 429 });
  });

  it('gives a different admin an independent budget despite sharing the same IP (not IP-tracked)', async () => {
    const server = app.getHttpServer();

    // This principal has made zero requests yet, even though every request
    // in this test suite originates from the same supertest/loopback "IP" as
    // the principal blocked above — proving the tracking key is the admin's
    // id, not the connection's address.
    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-other')
      .expect(200);
    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-other')
      .expect(200);
    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-other')
      .expect(429);
  });
});
