import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { of } from 'rxjs';
import { FlashcardsController } from './flashcards.controller';
import { RAG_GRPC_CLIENT } from '../grpc-clients/rag-client.provider';
import { AuthGuard } from '../guards/auth.guard';
import { GeminiUsageRepository } from '@app/database';
import { FlashcardGeneratorService } from './flashcard-generator.service';

const VALID_BODY = {
  student_id: 'body-supplied-id-should-be-ignored',
  subject: 'Chemistry',
  level: 'AL',
  stream: 'Bio',
  syllabus: 'local',
  medium: 'english',
  count: 10,
};

function chunk(content: string) {
  return { chunkId: 'c1', paperId: 'p1', content, subject: 'Chemistry', year: 2023, questionNumber: '', page: 0, relevanceScore: 0.9 };
}

describe('FlashcardsController', () => {
  const search = jest.fn();
  const tryReserveSlot = jest.fn();
  const releaseSlot = jest.fn();
  const generate = jest.fn();
  let controller: FlashcardsController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [FlashcardsController],
      providers: [
        { provide: RAG_GRPC_CLIENT, useValue: { search } },
        { provide: GeminiUsageRepository, useValue: { tryReserveSlot, releaseSlot } },
        { provide: FlashcardGeneratorService, useValue: { generate } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(FlashcardsController);
  });

  const req = { principal: { id: 'jwt-verified-student-id', type: 'student', role: 'student' } } as any;

  it("derives student_id from the verified JWT principal, not the request body's convenience value", async () => {
    search.mockReturnValue(of({ chunks: [chunk('excerpt')] }));
    tryReserveSlot.mockResolvedValue(true);
    generate.mockResolvedValue([{ front: 'Q', back: 'A' }]);

    await controller.generate(VALID_BODY as any, req);

    // The controller must never forward the body's student_id anywhere that
    // matters for authorization -- verified indirectly: no collaborator call
    // receives the body's spoofed id at all.
    expect(search.mock.calls[0][0]).not.toMatchObject({ studentId: VALID_BODY.student_id });
  });

  it('normalizes level to lowercase before filtering (frontend sends AL/OL, papers.level stores al/ol)', async () => {
    search.mockReturnValue(of({ chunks: [chunk('excerpt')] }));
    tryReserveSlot.mockResolvedValue(true);
    generate.mockResolvedValue([{ front: 'Q', back: 'A' }]);

    await controller.generate(VALID_BODY as any, req);

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('Chemistry'),
        subject: 'Chemistry',
        syllabus: 'local',
        level: 'al',
        medium: 'english',
      }),
    );
  });

  it('does not use the bare subject name as the RAG query (verified live: scores too low against Cohere\'s rerank threshold to retrieve real ingested content)', async () => {
    search.mockReturnValue(of({ chunks: [chunk('excerpt')] }));
    tryReserveSlot.mockResolvedValue(true);
    generate.mockResolvedValue([{ front: 'Q', back: 'A' }]);

    await controller.generate(VALID_BODY as any, req);

    const [[searchArgs]] = search.mock.calls;
    expect(searchArgs.query).not.toBe(VALID_BODY.subject);
  });

  it('returns {cards: [], reason: "no_content"} without touching the quota when RAG finds nothing', async () => {
    search.mockReturnValue(of({ chunks: [] }));

    const result = await controller.generate(VALID_BODY as any, req);

    expect(result).toEqual({ cards: [], reason: 'no_content' });
    expect(tryReserveSlot).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('throws a 429 with the exact quota_exhausted shape when the daily slot cannot be reserved, without calling Gemini', async () => {
    search.mockReturnValue(of({ chunks: [chunk('excerpt')] }));
    tryReserveSlot.mockResolvedValue(false);

    await expect(controller.generate(VALID_BODY as any, req)).rejects.toThrow(HttpException);
    expect(generate).not.toHaveBeenCalled();

    try {
      await controller.generate(VALID_BODY as any, req);
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(429);
      expect((e as HttpException).getResponse()).toEqual({
        error: 'quota_exhausted',
        message: expect.stringMatching(/today.*limit/i),
      });
    }
  });

  it('reserves the flashcards slice of the shared quota, then generates and returns cards', async () => {
    const chunks = [chunk('excerpt one'), chunk('excerpt two')];
    search.mockReturnValue(of({ chunks }));
    tryReserveSlot.mockResolvedValue(true);
    generate.mockResolvedValue([{ front: 'Q', back: 'A' }]);

    const result = await controller.generate(VALID_BODY as any, req);

    expect(tryReserveSlot).toHaveBeenCalledWith('flashcards', expect.any(Number));
    expect(generate).toHaveBeenCalledWith('Chemistry', ['excerpt one', 'excerpt two'], 10);
    expect(result).toEqual({ cards: [{ front: 'Q', back: 'A' }] });
    expect(releaseSlot).not.toHaveBeenCalled();
  });

  it('releases the reserved quota slot when generation fails, and still surfaces the original error', async () => {
    search.mockReturnValue(of({ chunks: [chunk('excerpt')] }));
    tryReserveSlot.mockResolvedValue(true);
    const generationError = new Error('Gemini call failed');
    generate.mockRejectedValue(generationError);

    await expect(controller.generate(VALID_BODY as any, req)).rejects.toBe(generationError);
    expect(releaseSlot).toHaveBeenCalledWith('flashcards');
  });
});
