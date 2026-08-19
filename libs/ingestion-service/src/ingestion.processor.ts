import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import pdfParse from 'pdf-parse';
import { DatabaseService, StorageService } from '@app/database';
import { IngestionJobPayload } from './queue/ingestion-job.types';
import { GeminiExtractor, ExtractedChunk } from './extraction/gemini-extractor';
import { chunkByFixedWindow } from './extraction/fallback-chunker';

@Injectable()
export class IngestionProcessor {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly geminiExtractor: GeminiExtractor,
  ) {}

  async process(job: Job<IngestionJobPayload>): Promise<void> {
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
    } catch (err) {
      this.logger.error(`Ingestion failed for paper ${paperId}: ${(err as Error).message}`);
      await this.db.query(`update papers set status = 'failed', error_reason = $2 where id = $1`, [
        paperId,
        (err as Error).message,
      ]);
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
