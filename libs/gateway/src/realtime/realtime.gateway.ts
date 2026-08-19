import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

/**
 * Pushes ingestion lifecycle events to connected clients over Socket.IO, per
 * SPEC-SHEET.md §14's mobile channel. `IngestionProcessor` calls
 * `emitIngestionStatus` directly (right before returning) once a job settles
 * — see Task 61's brief for why a BullMQ `QueueEvents` listener was rejected
 * in favor of this simpler direct call.
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: true } })
export class RealtimeGateway {
  @WebSocketServer() server!: Server;

  emitIngestionStatus(payload: { paper_id: string; status: string; chunk_count?: number }): void {
    this.server.emit('paper:ingestion_status', payload);
  }
}
