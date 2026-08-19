import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/**
 * `RealtimeGateway` lives in its own module (rather than being declared
 * directly on `GatewayModule`) so `IngestionServiceModule` can depend on it
 * without importing `GatewayModule` itself. `GatewayModule` already imports
 * `IngestionQueueModule` (from `@app/ingestion-service`'s barrel); if
 * `IngestionServiceModule` imported `GatewayModule` back (also via its
 * barrel, `@app/gateway`), the two libs' `index.ts` files would require each
 * other, and Node's CommonJS circular-require handling would hand one side a
 * partially-populated exports object at evaluation time. This module has no
 * imports of its own, so importing it — always via the deep path
 * `@app/gateway/realtime/realtime.module`, never through `@app/gateway`'s
 * barrel — never touches `gateway.module.ts` and can't reintroduce the cycle.
 */
@Module({
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
