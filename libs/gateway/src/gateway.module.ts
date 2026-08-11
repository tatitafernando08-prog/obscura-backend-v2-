import { Module } from '@nestjs/common';
import { ChatController } from './chat/chat.controller';
import { GatewayAskService } from './ask/ask.service';
import { AuthGuard } from './guards/auth.guard';
import { authClientProvider } from './grpc-clients/auth-client.provider';
import { ragClientProvider } from './grpc-clients/rag-client.provider';
import { chatClientProvider } from './grpc-clients/chat-client.provider';

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
  controllers: [ChatController],
  providers: [GatewayAskService, AuthGuard, authClientProvider, ragClientProvider, chatClientProvider],
})
export class GatewayModule {}
