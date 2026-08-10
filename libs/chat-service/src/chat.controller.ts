import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ChatLlmAskService } from './ask.service';
import { AskRequest, AskResponse } from '@app/proto/generated/chat';

@Controller()
export class ChatController {
  constructor(private readonly askService: ChatLlmAskService) {}

  @GrpcMethod('ChatLlmService', 'Ask')
  async ask(request: AskRequest): Promise<AskResponse> {
    const chunks = request.retrievedChunks.map((c, i) => ({
      index: i + 1,
      content: c.content,
      subject: c.subject,
      year: c.year,
    }));

    const result = await this.askService.ask({
      questionText: request.questionText,
      medium: request.medium,
      history: request.history.map((h) => ({ role: h.role, content: h.content })),
      chunks,
    });

    return {
      answer: result.answer,
      sources: result.sources,
      grounded: result.grounded,
    };
  }
}
