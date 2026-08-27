import { Body, Controller, HttpCode, HttpException, HttpStatus, Inject, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { firstValueFrom } from 'rxjs';
import { AuthGuard } from '../guards/auth.guard';
import { RAG_GRPC_CLIENT } from '../grpc-clients/rag-client.provider';
import { RagServiceClient } from '@app/proto/generated/rag';
import { GeminiUsageRepository } from '@app/database';
import { FlashcardGeneratorService } from './flashcard-generator.service';
import { FlashcardsGenerateDto } from './dto/flashcards-generate.dto';

const FLASHCARDS_DAILY_LIMIT = 5; // this feature's reserved slice of Gemini's 20-req/day account-wide cap
const RETRIEVAL_TOP_K = 30; // wide coverage for Gemini to draw a whole batch of cards from, not one precise answer

type AuthedRequest = Request & { principal: { id: string } };

@Controller('flashcards')
export class FlashcardsController {
  private readonly logger = new Logger(FlashcardsController.name);

  constructor(
    @Inject(RAG_GRPC_CLIENT) private readonly ragClient: RagServiceClient,
    private readonly geminiUsage: GeminiUsageRepository,
    private readonly generator: FlashcardGeneratorService,
  ) {}

  @Post('generate')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async generate(@Body() body: FlashcardsGenerateDto, @Req() req: AuthedRequest) {
    // AuthGuard has already verified the JWT; this is the authoritative
    // student id for a shared endpoint against a scarce daily quota --
    // body.student_id is convenience/logging only, never trusted.
    this.logger.log(`flashcards/generate requested by student ${req.principal.id} for ${body.subject}`);

    const searchResult = await firstValueFrom(
      this.ragClient.search({
        // The bare subject name alone scores too low against Cohere's rerank
        // threshold (verified: 0.21 best score for "Economics" against real
        // ingested content that clearly exists) -- this phrasing consistently
        // clears it (verified: 0.35-0.71 against the same content).
        query: `past exam paper questions and key concepts in ${body.subject}`,
        subject: body.subject,
        syllabus: body.syllabus,
        // Frontend sends 'OL'/'AL' (profile.exam_type); papers.level is
        // stored lowercase ('ol'/'al') -- confirmed against real data.
        level: body.level.toLowerCase(),
        medium: body.medium,
        topK: RETRIEVAL_TOP_K,
      }),
    );

    if (searchResult.chunks.length === 0) {
      return { cards: [], reason: 'no_content' };
    }

    const reserved = await this.geminiUsage.tryReserveSlot('flashcards', FLASHCARDS_DAILY_LIMIT);
    if (!reserved) {
      throw new HttpException(
        {
          error: 'quota_exhausted',
          message: "AI flashcards are at today's limit — try again tomorrow.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      const cards = await this.generator.generate(
        body.subject,
        searchResult.chunks.map((c) => c.content),
        body.count,
      );
      return { cards };
    } catch (err) {
      // The slot above is reserved before we know Gemini will actually
      // succeed -- give it back on failure so a Gemini-side error doesn't
      // permanently cost part of the feature's scarce daily budget.
      await this.geminiUsage.releaseSlot('flashcards');
      throw err;
    }
  }
}
