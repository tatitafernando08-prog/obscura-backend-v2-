import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DatabaseService, StorageService } from '@app/database';
// Deep import (not the `@app/gateway` barrel) so this file never triggers
// `gateway.module.ts`, which imports `IngestionQueueModule` from this lib's
// own barrel — going through `@app/gateway`'s index here would create a
// circular require between the two libs' index.ts files. See
// `realtime.module.ts` for the full explanation.
import { RealtimeGateway } from '@app/gateway/realtime/realtime.gateway';
import { IngestionJobPayload } from './queue/ingestion-job.types';
import { GeminiExtractor, ExtractedChunk } from './extraction/gemini-extractor';
import { chunkByFixedWindow } from './extraction/fallback-chunker';
import { parsePdfInWorker } from './extraction/pdf-parse-in-worker';
import { ChunkUpsertService } from './chunk-upsert.service';

@Injectable()
export class IngestionProcessor {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly geminiExtractor: GeminiExtractor,
    private readonly chunkUpsert: ChunkUpsertService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  async process(
    job: Job<IngestionJobPayload>,
  ): Promise<{ status: 'ready' | 'failed'; chunkCount?: number }> {
    const { paperId } = job.data;
    try {
      const paper = await this.loadPaper(paperId);
      const pdfBuffer = await this.storage.downloadPdf(paper.storage_path);

      let chunks: ExtractedChunk[];
      try {
        chunks = await this.geminiExtractor.extractChunks(pdfBuffer);
      } catch (extractionErr) {
        this.logger.warn(
          `Gemini extraction failed for paper ${paperId}, falling back to fixed-window: ${(extractionErr as Error).message}`,
        );
        const text = await parsePdfInWorker(pdfBuffer);
        chunks = chunkByFixedWindow(text);
      }

      const chunkCount = await this.chunkUpsert.upsertChunks(paperId, chunks);
      this.logger.log(`Upserted ${chunkCount} chunks for paper ${paperId}`);
      await this.db.query(`update papers set status = 'ready' where id = $1`, [paperId]);
      this.pushStatus({ paper_id: paperId, status: 'ready', chunk_count: chunkCount });

      return { status: 'ready', chunkCount };
    } catch (err) {
      this.logger.error(`Ingestion failed for paper ${paperId}: ${(err as Error).message}`);
      await this.db.query(`update papers set status = 'failed', error_reason = $2 where id = $1`, [
        paperId,
        (err as Error).message,
      ]);
      this.pushStatus({ paper_id: paperId, status: 'failed' });

      return { status: 'failed' };
    }
  }

  /**
   * Wraps `RealtimeGateway.emitIngestionStatus` so a WS push failure (e.g. a
   * socket.io internal error) can never affect the paper's DB status or the
   * BullMQ job's outcome. Without this isolation, a throwing emit on the
   * success path would fall into `process()`'s outer `catch` and incorrectly
   * overwrite an already-successful paper with `status = 'failed'`; on the
   * failure path it would become an unhandled rejection even though the DB
   * was already correctly written as `'failed'`. The DB write and `return`
   * always happen regardless of whether this call throws.
   */
  private pushStatus(payload: { paper_id: string; status: string; chunk_count?: number }): void {
    try {
      this.realtimeGateway.emitIngestionStatus(payload);
    } catch (emitErr) {
      this.logger.error(
        `Failed to emit paper:ingestion_status for paper ${payload.paper_id}: ${(emitErr as Error).message}`,
      );
    }
  }

  private async loadPaper(paperId: string): Promise<{ storage_path: string }> {
    const rows = await this.db.query<{ storage_path: string }>(
      'select storage_path from papers where id = $1',
      [paperId],
    );
    if (!rows[0]) throw new Error(`paper ${paperId} not found`);
    return rows[0];
  }
}
