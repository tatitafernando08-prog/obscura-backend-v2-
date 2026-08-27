import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from '@google/generative-ai';
import { EnvConfig, callWithRetry } from '@app/common';

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isTransientGeminiError(err: unknown): boolean {
  return err instanceof GoogleGenerativeAIFetchError && err.status === 503;
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
    const result = await callWithRetry(() => model.generateContent(prompt), {
      maxAttempts: RETRY_MAX_ATTEMPTS,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      isRetryable: isTransientGeminiError,
    });
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
