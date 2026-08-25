import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { EnvConfig } from '@app/common';
import { callWithAbortTimeout } from './call-with-abort-timeout';

const EXTRACTION_TIMEOUT_MS = 45_000;

export interface ExtractedChunk {
  content: string;
  questionNumber?: string;
  marks?: number;
  topic?: string;
  page?: number;
}

const EXTRACTION_PROMPT = `You are segmenting a past exam paper PDF into individually-addressable
chunks, one per question (or sub-question if long). For each chunk, extract:
- content: the full question text, verbatim, in its original language/script (English, Sinhala, or Tamil)
- question_number: e.g. "3(a)" if visible
- marks: the mark allocation if shown, as a number
- topic: a short topic label if inferable (e.g. "Demand and Supply")
- page: the 1-indexed page number the question appears on

Respond with ONLY a JSON array of objects with exactly these keys: content, question_number, marks, topic, page.
Do not cut any question mid-sentence. Do not merge multiple distinct questions into one chunk.`;

@Injectable()
export class GeminiExtractor {
  private readonly client: GoogleGenerativeAI;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = new GoogleGenerativeAI(config.get('GEMINI_API_KEY', { infer: true }));
  }

  async extractChunks(pdfBuffer: Buffer): Promise<ExtractedChunk[]> {
    // 'gemini-2.5-flash' returns 404 "no longer available to new users" as of
    // the current API key's cohort; 'gemini-flash-latest' is Google's rolling
    // alias for the current-generation flash model and avoids this class of
    // breakage going forward (see libs/chat-service/src/gemini-chat.service.ts).
    const model = this.client.getGenerativeModel({ model: 'gemini-flash-latest' });
    const result = await callWithAbortTimeout(
      (signal) =>
        model.generateContent(
          [
            { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
            { text: EXTRACTION_PROMPT },
          ],
          { signal },
        ),
      EXTRACTION_TIMEOUT_MS,
    );

    const raw = result.response.text().trim();
    const jsonText = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    let parsed: any[];
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error(`Gemini structural extraction returned non-JSON output: ${raw.slice(0, 200)}`);
    }

    return parsed
      .filter((c) => typeof c.content === 'string' && c.content.trim().length > 0)
      .map((c) => ({
        content: c.content,
        questionNumber: c.question_number || undefined,
        marks: typeof c.marks === 'number' ? c.marks : undefined,
        topic: c.topic || undefined,
        page: typeof c.page === 'number' ? c.page : undefined,
      }));
  }
}
