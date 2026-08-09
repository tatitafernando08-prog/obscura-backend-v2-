import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@app/common';
import { DatabaseModule, DatabaseService } from '@app/database';
import { GeminiEmbeddingService } from '@app/rag-service/gemini-embedding.service';

const SEED_PAPERS: Array<{
  subject: string;
  year: number;
  syllabus: string;
  level: string;
  medium: string;
  chunks: string[];
}> = [
  {
    subject: 'Economics',
    year: 2022,
    syllabus: 'local',
    level: 'al',
    medium: 'english',
    chunks: [
      'Question 3(a): State the law of demand. The law of demand states that, ceteris paribus, as the price of a good rises, the quantity demanded falls, and vice versa.',
      'Question 3(b): Explain price elasticity of demand. Price elasticity of demand measures the responsiveness of quantity demanded to a change in price, calculated as %ΔQd / %ΔP.',
    ],
  },
  {
    subject: 'Physics',
    year: 2021,
    syllabus: 'local',
    level: 'al',
    medium: 'english',
    chunks: [
      "Question 5: State Newton's Second Law of Motion. The rate of change of momentum of a body is directly proportional to the applied force and occurs in the direction of the force: F = ma.",
      'Question 6: Define kinetic energy and derive its formula. Kinetic energy is the energy possessed by a body due to its motion, given by KE = 1/2 mv^2.',
    ],
  },
  {
    subject: 'Combined Mathematics',
    year: 2023,
    syllabus: 'local',
    level: 'al',
    medium: 'english',
    chunks: [
      'Question 1: Solve the quadratic equation x^2 - 5x + 6 = 0. Factorising gives (x-2)(x-3)=0, so x=2 or x=3.',
      'Question 2: Differentiate y = x^3 + 2x with respect to x. dy/dx = 3x^2 + 2.',
    ],
  },
];

@Module({ imports: [AppConfigModule, DatabaseModule] })
class SeedModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule);
  const db = app.get(DatabaseService);
  const embeddings = new GeminiEmbeddingService(app.get(ConfigService));

  for (const paper of SEED_PAPERS) {
    const [{ id: paperId }] = await db.query<{ id: string }>(
      `insert into papers (subject, year, syllabus, level, medium, storage_path, status)
       values ($1, $2, $3, $4, $5, $6, 'ready') returning id`,
      [paper.subject, paper.year, paper.syllabus, paper.level, paper.medium, `seed/${paper.subject}-${paper.year}.pdf`],
    );

    for (const [index, content] of paper.chunks.entries()) {
      const embedding = await embeddings.embed(content, 'RETRIEVAL_DOCUMENT');
      await db.query(
        `insert into paper_chunks (paper_id, chunk_index, content, embedding)
         values ($1, $2, $3, $4::vector)`,
        [paperId, index, content, `[${embedding.join(',')}]`],
      );
    }
    console.log(`Seeded ${paper.subject} ${paper.year} (${paper.medium}): ${paper.chunks.length} chunks`);
  }

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
