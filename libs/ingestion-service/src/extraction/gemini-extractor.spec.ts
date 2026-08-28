import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GeminiExtractor } from './gemini-extractor';

describe('GeminiExtractor (integration, real Gemini call)', () => {
  let extractor: GeminiExtractor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [GeminiExtractor],
    }).compile();
    extractor = moduleRef.get(GeminiExtractor);
  });

  it('extracts at least one non-empty chunk from a real sample PDF', async () => {
    const pdf = readFileSync(join(__dirname, '../../test/fixtures/sample-paper.pdf'));
    const chunks = await extractor.extractChunks(pdf);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content.length).toBeGreaterThan(10);
  });
});
