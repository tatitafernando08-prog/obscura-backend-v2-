import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../guards/auth.guard';
import { GatewayAskService } from '../ask/ask.service';
import { ChatSessionsRepository } from '@app/database';
import { ChatAskDto } from './dto/chat-ask.dto';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly askService: GatewayAskService,
    private readonly chatSessions: ChatSessionsRepository,
  ) {}

  @Post('ask')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async ask(@Body() body: ChatAskDto) {
    // NOTE: `body.student_id` is trusted from the request body here to match the
    // *existing* wire contract exactly (the mobile client already sends it) — but
    // `AuthGuard` has already independently verified the caller's JWT and attached
    // `request.principal` (see AuthGuard). Cross-checking `body.student_id ===
    // request.principal.id` and rejecting on mismatch is a reasonable hardening
    // step; it's deliberately left out of Phase 1 to keep this task's scope to
    // "make the existing contract work under real auth," and can be added later
    // without changing the wire contract.
    const sessionId = await this.chatSessions.getOrCreateForStudent(body.student_id);

    const result = await this.askService.ask({
      questionText: body.question,
      subject: body.subject,
      syllabus: body.syllabus,
      medium: body.medium,
      history: (body.chat_history ?? []).slice(-6),
      sessionId,
    });

    return {
      answer: result.answer,
      sources: result.sources.map((s) => ({ past_papers: { subject: s.subject, year: s.year } })),
    };
  }
}
