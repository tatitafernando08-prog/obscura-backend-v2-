import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@app/common';
import { DatabaseModule, DatabaseService } from '@app/database';
import { HybridSearchService } from '@app/rag-service/hybrid-search';
import { RerankService } from '@app/rag-service/rerank.service';
import { GeminiEmbeddingService } from '@app/rag-service/gemini-embedding.service';

const LABELED_QUERIES: { query: string; expectedSubstring: string }[] = [
  {
    query: 'මිල ඉහළ ගියොත් ඉල්ලුමට වෙන දේ මොකක්ද?',
    expectedSubstring: 'ඉල්ලුමේ නියමය',
  }, // "what happens to demand if price rises?"
  {
    query: 'ප්‍රත්‍යාස්ථතාව යනු කුමක්ද?',
    expectedSubstring: 'ප්‍රත්‍යාස්ථතාව',
  }, // "what is elasticity?"
  {
    query: 'මිල ඉහළ ගියොත් සැපයුමට වෙන දේ මොකක්ද?',
    expectedSubstring: 'සැපයුමේ නියමය',
  }, // "what happens to supply if price rises?"
  {
    query: 'වෙළඳපොල සමතුලිතතාවය පැහැදිලි කරන්න',
    expectedSubstring: 'සමතුලිතතාවය',
  }, // "explain market equilibrium"
];

@Module({ imports: [AppConfigModule, DatabaseModule] })
class EvalModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(EvalModule);
  const embeddings = new GeminiEmbeddingService(app.get(ConfigService));
  const hybridSearch = new HybridSearchService(
    app.get(DatabaseService),
    embeddings,
  );
  const rerank = new RerankService(app.get(ConfigService));

  let hits = 0;
  for (const { query, expectedSubstring } of LABELED_QUERIES) {
    const candidates = await hybridSearch.retrieveCandidates(query, {
      medium: 'sinhala',
    });
    const ranked = await rerank.rerank(query, candidates.slice(0, 20), 3);
    const found = ranked.some((c) => c.content.includes(expectedSubstring));
    console.log(
      `${found ? 'HIT ' : 'MISS'} — "${query}" (top result: ${ranked[0]?.content.slice(0, 60) ?? 'none'})`,
    );
    if (found) hits += 1;
  }

  const hitRate = hits / LABELED_QUERIES.length;
  console.log(
    `\nSinhala retrieval hit rate: ${(hitRate * 100).toFixed(0)}% (${hits}/${LABELED_QUERIES.length})`,
  );
  console.log(
    hitRate >= 0.7
      ? 'PASS: native multilingual retrieval looks adequate — no query-translation-bridge needed for now.'
      : 'FAIL: consider implementing the query-translation-bridge fallback described in SPEC-SHEET.md §7 before relying on Sinhala text-chat retrieval quality.',
  );

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
