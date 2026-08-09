import { Injectable } from '@nestjs/common';
import { buildPrompt, PromptChunk } from './prompt-builder';
import { GeminiChatService } from './gemini-chat.service';

export interface AskInput {
  questionText: string;
  medium: string;
  history: { role: string; content: string }[];
  chunks: PromptChunk[];
}

export interface SourceCitation {
  subject: string;
  year: string;
}

export interface AskResult {
  answer: string;
  sources: SourceCitation[];
  grounded: boolean;
}

@Injectable()
export class ChatLlmAskService {
  constructor(private readonly gemini: GeminiChatService) {}

  async ask(input: AskInput): Promise<AskResult> {
    const first = await this.attempt(input, false);
    const firstSources = this.resolveSources(first.citedIndices, input.chunks);
    if (this.isGrounded(first, firstSources)) {
      return this.toResult(first, firstSources);
    }

    const retry = await this.attempt(input, true);
    const retrySources = this.resolveSources(retry.citedIndices, input.chunks);
    return this.toResult(retry, retrySources);
  }

  private async attempt(input: AskInput, strict: boolean) {
    const prompt = buildPrompt({ ...input, strict });
    return this.gemini.generate(prompt);
  }

  private resolveSources(citedIndices: number[], chunks: PromptChunk[]): SourceCitation[] {
    return citedIndices
      .map((i) => chunks.find((c) => c.index === i))
      .filter((c): c is PromptChunk => Boolean(c))
      .map((c) => ({ subject: c.subject, year: String(c.year) }));
  }

  private isGrounded(result: { isCurriculumQuestion: boolean }, sources: SourceCitation[]): boolean {
    // Small talk never needs grounding. Curriculum questions need at least one RESOLVED source.
    return !result.isCurriculumQuestion || sources.length > 0;
  }

  private toResult(
    result: { answer: string; isCurriculumQuestion: boolean },
    sources: SourceCitation[],
  ): AskResult {
    return {
      answer: result.answer,
      sources,
      grounded: this.isGrounded(result, sources),
    };
  }
}
