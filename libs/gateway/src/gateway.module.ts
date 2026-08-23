import { Module } from '@nestjs/common';
import { ChatController } from './chat/chat.controller';
import { AdminDevicesController } from './admin/devices.controller';
import { PapersUploadController } from './admin/papers-upload.controller';
import { MetricsController } from './admin/metrics.controller';
import { PapersController } from './papers/papers.controller';
import { VoiceController } from './voice/voice.controller';
import { GatewayAskService } from './ask/ask.service';
import { AuthGuard } from './guards/auth.guard';
import { AdminGuard } from './admin/guards/admin.guard';
import { DeviceAuthGuard } from './guards/device-auth.guard';
import { authClientProvider } from './grpc-clients/auth-client.provider';
import { ragClientProvider } from './grpc-clients/rag-client.provider';
import { chatClientProvider } from './grpc-clients/chat-client.provider';
import { speechClientProvider } from './grpc-clients/speech-client.provider';
import { DeviceKeyService } from '@app/auth-service';
import { IngestionQueueModule } from '@app/ingestion-service';
import { RealtimeModule } from './realtime/realtime.module';

/**
 * Bundles the HTTP-facing gateway surface: controllers, the gRPC client
 * providers that talk to the auth/rag/chat microservices, and the
 * request-scoped services/guards that depend on them.
 *
 * `ChatSessionsRepository` (used by both `ChatController` and
 * `GatewayAskService`) comes from `@app/database`'s `DatabaseModule`, which
 * is `@Global()` — it does not need to be re-declared here.
 */
@Module({
  imports: [IngestionQueueModule, RealtimeModule],
  controllers: [
    ChatController,
    AdminDevicesController,
    PapersUploadController,
    PapersController,
    MetricsController,
    VoiceController,
  ],
  providers: [
    GatewayAskService,
    AuthGuard,
    AdminGuard,
    DeviceAuthGuard,
    DeviceKeyService,
    authClientProvider,
    ragClientProvider,
    chatClientProvider,
    speechClientProvider,
  ],
})
export class GatewayModule {}
