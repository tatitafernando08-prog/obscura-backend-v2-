import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@app/database';
import { GeminiEmbeddingService } from './gemini-embedding.service';
import { rrf } from './rrf';

export interface Filters {
  subject?: string;
  syllabus?: string;
  level?: string;
  medium?: string;
}

export interface CandidateChunk {
  chunkId: string;
  paperId: string;
  content: string;
  subject: string;
  year: number | null;
  questionNumber: string | null;
  page: number | null;
}

const CANDIDATES_PER_LIST = 30;
const FUSED_CANDIDATES_LIMIT = 20;

@Injectable()
export class HybridSearchService {
  constructor(
    private readonly db: DatabaseService,
    private readonly embeddings: GeminiEmbeddingService,
  ) {}

  async retrieveCandidates(query: string, filters: Filters): Promise<CandidateChunk[]> {
    const [vectorList, ftsList] = await Promise.all([
      this.vectorSearch(query, filters),
      this.fullTextSearch(query, filters),
    ]);

    return rrf([vectorList, ftsList], (c) => c.chunkId).slice(0, FUSED_CANDIDATES_LIMIT);
  }

  private filterClause(filters: Filters, startParam: number): { clause: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let i = startParam;
    for (const [column, value] of [
      ['subject', filters.subject],
      ['syllabus', filters.syllabus],
      ['level', filters.level],
      ['medium', filters.medium],
    ] as const) {
      if (value) {
        conditions.push(`p.${column} = $${i}`);
        params.push(value);
        i += 1;
      }
    }
    return { clause: conditions.length ? `and ${conditions.join(' and ')}` : '', params };
  }

  private async vectorSearch(query: string, filters: Filters): Promise<CandidateChunk[]> {
    const embedding = await this.embeddings.embed(query, 'RETRIEVAL_QUERY');
    const { clause, params } = this.filterClause(filters, 2); // $1 = embedding, filters start at $2
    const rows = await this.db.query<CandidateChunkRow>(
      `select pc.id as chunk_id, pc.paper_id, pc.content, p.subject, p.year,
              pc.metadata->>'question_number' as question_number,
              (pc.metadata->>'page')::int as page
       from paper_chunks pc
       join papers p on p.id = pc.paper_id
       where p.status = 'ready' ${clause}
       order by pc.embedding <=> $1::vector
       limit ${CANDIDATES_PER_LIST}`,
      [`[${embedding.join(',')}]`, ...params],
    );
    return rows.map(toCandidateChunk);
  }

  private async fullTextSearch(query: string, filters: Filters): Promise<CandidateChunk[]> {
    const { clause, params } = this.filterClause(filters, 2);
    const rows = await this.db.query<CandidateChunkRow>(
      `select pc.id as chunk_id, pc.paper_id, pc.content, p.subject, p.year,
              pc.metadata->>'question_number' as question_number,
              (pc.metadata->>'page')::int as page
       from paper_chunks pc
       join papers p on p.id = pc.paper_id
       where p.status = 'ready' and pc.content_tsv @@ plainto_tsquery('english', $1) ${clause}
       order by ts_rank(pc.content_tsv, plainto_tsquery('english', $1)) desc
       limit ${CANDIDATES_PER_LIST}`,
      [query, ...params],
    );
    return rows.map(toCandidateChunk);
  }
}

interface CandidateChunkRow {
  chunk_id: string;
  paper_id: string;
  content: string;
  subject: string;
  year: number | null;
  question_number: string | null;
  page: number | null;
}

function toCandidateChunk(row: CandidateChunkRow): CandidateChunk {
  return {
    chunkId: row.chunk_id,
    paperId: row.paper_id,
    content: row.content,
    subject: row.subject,
    year: row.year,
    questionNumber: row.question_number,
    page: row.page,
  };
}
