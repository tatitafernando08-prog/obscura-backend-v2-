import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@app/database';
import { GeminiEmbeddingService } from '@app/rag-service/gemini-embedding.service';
import { ExtractedChunk } from './extraction/gemini-extractor';

@Injectable()
export class ChunkUpsertService {
  constructor(
    private readonly db: DatabaseService,
    private readonly embeddings: GeminiEmbeddingService,
  ) {}

  async upsertChunks(paperId: string, chunks: ExtractedChunk[]): Promise<number> {
    let inserted = 0;
    for (const [index, chunk] of chunks.entries()) {
      const embedding = await this.embeddings.embed(chunk.content, 'RETRIEVAL_DOCUMENT');
      const metadata = {
        question_number: chunk.questionNumber,
        marks: chunk.marks,
        topic: chunk.topic,
        page: chunk.page,
      };
      await this.db.query(
        `insert into paper_chunks (paper_id, chunk_index, content, metadata, embedding)
         values ($1, $2, $3, $4, $5::vector)`,
        [paperId, index, chunk.content, JSON.stringify(metadata), `[${embedding.join(',')}]`],
      );
      inserted += 1;
    }
    return inserted;
  }
}
