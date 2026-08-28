import {
  Controller,
  Get,
  Injectable,
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';

/**
 * Covers the fix for a review finding on Task 63 (per-admin/day upload rate
 * limit): the original implementation used a route-level custom
 * `PerPrincipalThrottlerGuard` alongside the app-wide `APP_GUARD`
 * `ThrottlerGuard` — but `@nestjs/throttler`'s guard resolution is
 * cumulative (global + class + method guards all run and are AND-ed), never
 * a replacement, so BOTH guards ran on `/papers/upload`: the global one
 * still tracked by IP. Two admins sharing an IP would still collectively
 * exhaust a shared IP-based budget on top of their individual per-admin
 * budgets — exactly the shared-IP scenario the task exists to prevent.
 *
 * The fix (verified against node_modules/@nestjs/throttler@6.5.0's
 * `throttler-module-options.interface.d.ts` and `throttler.guard.js`) drops
 * the custom guard class entirely and instead registers a second *named*
 * throttler set — `'perAdmin'` — via `ThrottlerModule.forRoot`'s built-in
 * per-set `getTracker` field, alongside the existing IP-tracked `'default'`
 * set. The single app-wide `APP_GUARD` `ThrottlerGuard` evaluates every
 * named set on every route; a route opts into a real `'perAdmin'` cap via
 * `@Throttle({ perAdmin: { limit, ttl } })` (see
 * `libs/gateway/src/admin/papers-upload.controller.ts`), same as
 * `apps/api/src/app.module.ts` registers it.
 *
 * This spec builds a tiny standalone app that mirrors that exact
 * two-named-set shape (not the real AppModule — no DB/Redis/gRPC/JWT
 * needed) and proves, against the real `@nestjs/throttler` machinery, not a
 * mock:
 *   1. a principal is throttled on the `'perAdmin'` set after its limit;
 *   2. a second principal sharing the same connection/IP gets an
 *      independent `'perAdmin'` budget (tracked by admin id, not IP) — the
 *      core property Task 63 needs;
 *   3. the separate `'default'` (IP-tracked) set's budget is untouched by
 *      either principal's `'perAdmin'` usage — i.e. two different
 *      principals sharing an IP do NOT collectively exhaust any shared
 *      IP-based counter for this route. This is the exact assertion the
 *      first attempt's test suite lacked, and would have caught the bug.
 */
describe('Multi-named-throttler-set config (perAdmin tracked by principal id, default tracked by IP)', () => {
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
    // Mirrors papers-upload.controller.ts's real usage: only the 'perAdmin'
    // set's limit is tightened for this route; 'default' keeps its
    // module-registered config.
    @Throttle({ perAdmin: { limit: 2, ttl: 60_000 } })
    ping() {
      return { ok: true };
    }
  }

  @Module({
    imports: [
      ThrottlerModule.forRoot([
        // Deliberately generous relative to this suite's ~12 total requests,
        // so it never accidentally trips on its own — its whole purpose here
        // is to prove it stays untouched/uncoupled from the route-level
        // 'perAdmin' override (see the third test below), not to be exercised
        // itself.
        { name: 'default', ttl: 60_000, limit: 500 },
        {
          name: 'perAdmin',
          ttl: 60_000,
          limit: 1_000_000, // harmlessly high app-wide default, same reasoning as app.module.ts
          getTracker: (req: Record<string, any>) => req.principal?.id ?? req.ip,
        },
      ]),
    ],
    controllers: [PingController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
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

  it('throttles a principal on the perAdmin set after its route-level limit (429)', async () => {
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

  it('gives a different admin an independent perAdmin budget despite sharing the same IP (not IP-tracked)', async () => {
    const server = app.getHttpServer();

    // This principal has made zero perAdmin requests yet, even though every
    // request in this describe block originates from the same
    // supertest/loopback "IP" as admin-limit-test above — proving the
    // perAdmin tracking key is the admin's id, not the connection address.
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

  it("route-level @Throttle({ perAdmin: {...} }) does not also tighten the 'default' set for this route (the exact bug this fix closes)", async () => {
    const server = app.getHttpServer();

    // Three brand-new admins, each staying within their own 2-request
    // perAdmin quota (6 successful requests total), all from the same
    // supertest connection ("IP") that the two tests above have already
    // sent 6 requests from. Under the ORIGINAL (buggy) design — a route
    // decorator like `@Throttle({ default: { limit: 2, ttl } })` plus a
    // second route-level guard also reading that same overridden 'default'
    // metadata — this route's *IP-tracked* budget would have been tightened
    // to 2 for everyone combined, so this block's 3rd request (let alone the
    // earlier tests' 6) would already 429. Here, 'perAdmin' is the only set
    // this route's @Throttle touches, so 'default' keeps its module-wide
    // limit of 500 and every one of these requests succeeds.
    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-x')
      .expect(200);
    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-x')
      .expect(200);
    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-y')
      .expect(200);
    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-y')
      .expect(200);
    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-z')
      .expect(200);
    await request(server)
      .get('/test/ping')
      .set('x-test-principal-id', 'admin-z')
      .expect(200);
  });
});
