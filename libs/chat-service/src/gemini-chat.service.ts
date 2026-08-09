import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { EnvConfig } from '@app/common';

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
    const model = this.client.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(prompt);
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
