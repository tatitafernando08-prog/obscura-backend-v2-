import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppConfigModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { AuthServiceModule } from '@app/auth-service';
import { RagServiceModule } from '@app/rag-service';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AuthServiceModule,
    RagServiceModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]), // 60 req/min/IP default; tuned per-route from Task 31 onward
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
