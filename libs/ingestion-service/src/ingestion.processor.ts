import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DatabaseService, StorageService } from '@app/database';
import { IngestionJobPayload } from './queue/ingestion-job.types';

@Injectable()
export class IngestionProcessor {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  async process(job: Job<IngestionJobPayload>): Promise<void> {
    const { paperId } = job.data;
    try {
      const paper = await this.loadPaper(paperId);
      const pdfBuffer = await this.storage.downloadPdf(paper.storage_path);

      // Task 57 replaces this line with real Gemini structural extraction.
      throw new Error('extraction not yet implemented (Task 57)');
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
