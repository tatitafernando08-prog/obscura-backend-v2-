import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, GoogleGenerativeAIFetchError, GoogleGenerativeAIAbortError } from '@google/generative-ai';
import { EnvConfig, callWithAbortTimeout, callWithRetry } from '@app/common';

const GENERATION_TIMEOUT_MS = 45_000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isTransientGeminiError(err: unknown): boolean {
  // A 503 is Gemini saying "busy, try again"; an abort error means *we*
  // gave up waiting after GENERATION_TIMEOUT_MS -- Gemini under load has
  // been observed hanging with zero bytes instead of a fast error, and
  // that hang deserves the same retry treatment as an explicit 503.
  return (err instanceof GoogleGenerativeAIFetchError && err.status === 503) || err instanceof GoogleGenerativeAIAbortError;
}

export interface GeminiStructuredResult {
  answer: string;
  isCurriculumQuestion: boolean;
  citedIndices: number[];
}

@Injectable()
export class GeminiChatService {
  private readonly client: GoogleGenerativeAI;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = new GoogleGenerativeAI(config.get('GEMINI_API_KEY', { infer: true }));
  }

  async generate(prompt: string): Promise<GeminiStructuredResult> {
    // 'gemini-2.5-flash' returns 404 "no longer available to new users" as of
    // the current API key's cohort; 'gemini-flash-latest' is Google's rolling
    // alias for the current-generation flash model and avoids this class of
    // breakage going forward.
    const model = this.client.getGenerativeModel({ model: 'gemini-flash-latest' });
    const result = await callWithRetry(
      () => callWithAbortTimeout((signal) => model.generateContent(prompt, { signal }), GENERATION_TIMEOUT_MS),
      { maxAttempts: RETRY_MAX_ATTEMPTS, baseDelayMs: RETRY_BASE_DELAY_MS, isRetryable: isTransientGeminiError },
    );
    const raw = result.response.text().trim();
    const jsonText = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error(`Failed to parse Gemini structured output as JSON: ${raw.slice(0, 200)}`);
    }

    return {
      answer: String(parsed.answer ?? ''),
      isCurriculumQuestion: Boolean(parsed.is_curriculum_question),
      citedIndices: Array.isArray(parsed.cited_indices) ? parsed.cited_indices.map(Number).filter((n: number) => !Number.isNaN(n)) : [],
    };
  }
}
