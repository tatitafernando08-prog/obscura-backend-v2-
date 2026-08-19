import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppConfigModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { AuthServiceModule } from '@app/auth-service';
import { RagServiceModule } from '@app/rag-service';
import { ChatServiceModule } from '@app/chat-service';
import { GatewayModule } from '@app/gateway';
import { IngestionServiceModule } from '@app/ingestion-service';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AuthServiceModule,
    RagServiceModule,
    ChatServiceModule,
    GatewayModule,
    IngestionServiceModule,
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 60 }, // 60 req/min/IP; tuned per-route from Task 31 onward
      {
        name: 'perAdmin',
        ttl: 86_400_000,
        // Effectively unbounded default: every route is checked against every
        // named throttler set (see @nestjs/throttler's ThrottlerGuard.canActivate),
        // so this set's own default limit must stay harmlessly high or it would
        // silently rate-limit every route in the app. Only routes that opt in via
        // @Throttle({ perAdmin: { limit, ttl } }) (e.g. POST /papers/upload,
        // Task 63) get a real cap, tracked by admin id instead of IP.
        limit: 1_000_000,
        getTracker: (req: Record<string, any>) => req.principal?.id ?? req.ip,
      },
    ]),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
