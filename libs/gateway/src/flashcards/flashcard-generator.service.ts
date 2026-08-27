import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from '@google/generative-ai';
import { EnvConfig, callWithAbortTimeout, callWithRetry } from '@app/common';

export interface GeneratedCard {
  front: string;
  back: string;
}

const GENERATION_TIMEOUT_MS = 45_000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isTransientGeminiError(err: unknown): boolean {
  return err instanceof GoogleGenerativeAIFetchError && err.status === 503;
}

@Injectable()
export class FlashcardGeneratorService {
  private readonly client: GoogleGenerativeAI;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = new GoogleGenerativeAI(config.get('GEMINI_API_KEY', { infer: true }));
  }

  async generate(subject: string, chunkContents: string[], count: number): Promise<GeneratedCard[]> {
    const model = this.client.getGenerativeModel({ model: 'gemini-flash-latest' });
    const prompt = buildPrompt(subject, chunkContents, count);

    const result = await callWithRetry(
      () => callWithAbortTimeout((signal) => model.generateContent(prompt, { signal }), GENERATION_TIMEOUT_MS),
      { maxAttempts: RETRY_MAX_ATTEMPTS, baseDelayMs: RETRY_BASE_DELAY_MS, isRetryable: isTransientGeminiError },
    );

    const raw = result.response.text().trim();
    const jsonText = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error(`Gemini flashcard generation returned non-JSON output: ${raw.slice(0, 200)}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`Gemini flashcard generation returned non-JSON output: ${raw.slice(0, 200)}`);
    }

    return parsed
      .filter(
        (c): c is GeneratedCard =>
          typeof c === 'object' &&
          c !== null &&
          typeof (c as GeneratedCard).front === 'string' &&
          typeof (c as GeneratedCard).back === 'string' &&
          (c as GeneratedCard).front.trim().length > 0 &&
          (c as GeneratedCard).back.trim().length > 0,
      )
      .map((c) => ({ front: c.front, back: c.back }));
  }
}

function buildPrompt(subject: string, chunkContents: string[], count: number): string {
  const excerpts = chunkContents.map((c, i) => `[${i + 1}] ${c}`).join('\n\n');

  return `You are creating study flashcards for a student studying ${subject}, based on real past exam paper excerpts.

Generate exactly ${count} flashcards. Each has a "front" (a question or prompt) and a "back" (the answer), both plain text, no markdown formatting.
Base every flashcard on the content of the excerpts below -- do not introduce facts they don't support.

Respond with ONLY a JSON array of exactly ${count} objects, each with exactly the keys "front" and "back".

EXCERPTS:
${excerpts}`;
}
