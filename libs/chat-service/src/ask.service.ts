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
    if (this.isGrounded(first)) {
      return this.toResult(first, input.chunks);
    }

    const retry = await this.attempt(input, true);
    return this.toResult(retry, input.chunks);
  }

  private async attempt(input: AskInput, strict: boolean) {
    const prompt = buildPrompt({ ...input, strict });
    return this.gemini.generate(prompt);
  }

  private isGrounded(result: { isCurriculumQuestion: boolean; citedIndices: number[] }): boolean {
    // Small talk never needs grounding. Curriculum questions need at least one citation.
    return !result.isCurriculumQuestion || result.citedIndices.length > 0;
  }

  private toResult(
    result: { answer: string; isCurriculumQuestion: boolean; citedIndices: number[] },
    chunks: PromptChunk[],
  ): AskResult {
    const sources = result.citedIndices
      .map((i) => chunks.find((c) => c.index === i))
      .filter((c): c is PromptChunk => Boolean(c))
      .map((c) => ({ subject: c.subject, year: String(c.year) }));

    return {
      answer: result.answer,
      sources,
      grounded: this.isGrounded(result),
    };
  }
}
