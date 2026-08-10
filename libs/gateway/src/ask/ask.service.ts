import { Inject, Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { RAG_GRPC_CLIENT } from '../grpc-clients/rag-client.provider';
import { CHAT_GRPC_CLIENT } from '../grpc-clients/chat-client.provider';
import { RagServiceClient } from '@app/proto/generated/rag';
import { ChatLlmServiceClient } from '@app/proto/generated/chat';

export interface GatewayAskInput {
  questionText: string;
  subject?: string;
  syllabus?: string;
  level?: string;
  medium: string;
  history: { role: string; content: string }[];
}

export interface GatewayAskResult {
  answer: string;
  sources: { subject: string; year: string }[];
}

@Injectable()
export class GatewayAskService {
  constructor(
    @Inject(RAG_GRPC_CLIENT) private readonly ragClient: RagServiceClient,
    @Inject(CHAT_GRPC_CLIENT) private readonly chatClient: ChatLlmServiceClient,
  ) {}

  async ask(input: GatewayAskInput): Promise<GatewayAskResult> {
    const searchResult = await firstValueFrom(
      this.ragClient.search({
        query: input.questionText,
        subject: input.subject ?? '',
        syllabus: input.syllabus ?? '',
        level: input.level ?? '',
        medium: input.medium,
        topK: 5,
      }),
    );

    const askResult = await firstValueFrom(
      this.chatClient.ask({
        questionText: input.questionText,
        medium: input.medium,
        history: input.history,
        retrievedChunks: searchResult.chunks,
      }),
    );

    return { answer: askResult.answer, sources: askResult.sources };
  }
}
