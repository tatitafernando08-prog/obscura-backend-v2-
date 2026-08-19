import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
// pdf-parse uses `export =` (CommonJS) and this project's tsconfig doesn't set
// esModuleInterop, so a default import would compile to a `.default` access that
// doesn't exist on the module and throw "is not a function" at call time.
import pdfParse = require('pdf-parse');
import { DatabaseService, StorageService } from '@app/database';
import { IngestionJobPayload } from './queue/ingestion-job.types';
import { GeminiExtractor, ExtractedChunk } from './extraction/gemini-extractor';
import { chunkByFixedWindow } from './extraction/fallback-chunker';
import { ChunkUpsertService } from './chunk-upsert.service';

@Injectable()
export class IngestionProcessor {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly geminiExtractor: GeminiExtractor,
    private readonly chunkUpsert: ChunkUpsertService,
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
        const parsed = await pdfParse(pdfBuffer);
        chunks = chunkByFixedWindow(parsed.text);
      }

      const chunkCount = await this.chunkUpsert.upsertChunks(paperId, chunks);
      this.logger.log(`Upserted ${chunkCount} chunks for paper ${paperId}`);
      await this.db.query(`update papers set status = 'ready' where id = $1`, [paperId]);

      return { status: 'ready', chunkCount };
    } catch (err) {
      this.logger.error(`Ingestion failed for paper ${paperId}: ${(err as Error).message}`);
      await this.db.query(`update papers set status = 'failed', error_reason = $2 where id = $1`, [
        paperId,
        (err as Error).message,
      ]);
      return { status: 'failed' };
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
