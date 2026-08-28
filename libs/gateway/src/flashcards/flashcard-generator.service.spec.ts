import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { FlashcardGeneratorService } from './flashcard-generator.service';

// Mocked, not a live call -- unlike GeminiExtractor/GeminiChatService's real-API
// integration tests, this project is already fighting a 20-requests/day global
// Gemini quota (this whole feature exists because of it); adding a third
// live-call test to the routine suite would only make that worse. STT/TTS
// already established the "mock the external SDK" pattern for exactly this
// kind of external-API unit test in this codebase.
const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  ...jest.requireActual('@google/generative-ai'),
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn(() => ({ generateContent: mockGenerateContent })),
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GoogleGenerativeAIFetchError, GoogleGenerativeAIAbortError } = jest.requireActual('@google/generative-ai');

function fetchError(status: number, message: string) {
  return new GoogleGenerativeAIFetchError(message, status, 'Error', undefined);
}

function geminiResponse(text: string) {
  return { response: { text: () => text } };
}

describe('FlashcardGeneratorService', () => {
  let service: FlashcardGeneratorService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [FlashcardGeneratorService],
    }).compile();
    service = moduleRef.get(FlashcardGeneratorService);
  });

  it('parses a well-formed JSON array response into front/back cards', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiResponse(JSON.stringify([
        { front: 'What is the law of demand?', back: 'As price rises, quantity demanded falls.' },
        { front: 'Define elasticity.', back: 'Responsiveness of quantity to price change.' },
      ])),
    );

    const cards = await service.generate('Economics', ['excerpt one', 'excerpt two'], 2);

    expect(cards).toEqual([
      { front: 'What is the law of demand?', back: 'As price rises, quantity demanded falls.' },
      { front: 'Define elasticity.', back: 'Responsiveness of quantity to price change.' },
    ]);
  });

  it('strips a markdown code-fence wrapper before parsing, matching GeminiExtractor/GeminiChatService', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiResponse('```json\n' + JSON.stringify([{ front: 'Q', back: 'A' }]) + '\n```'),
    );

    const cards = await service.generate('Economics', ['excerpt'], 1);

    expect(cards).toEqual([{ front: 'Q', back: 'A' }]);
  });

  it('drops malformed entries (missing front/back) rather than crashing on the whole batch', async () => {
    mockGenerateContent.mockResolvedValue(
      geminiResponse(JSON.stringify([
        { front: 'Good card', back: 'Has both fields' },
        { front: 'Missing back' },
        { back: 'Missing front' },
      ])),
    );

    const cards = await service.generate('Economics', ['excerpt'], 3);

    expect(cards).toEqual([{ front: 'Good card', back: 'Has both fields' }]);
  });

  it('throws a clear error when Gemini returns non-JSON output', async () => {
    mockGenerateContent.mockResolvedValue(geminiResponse('sorry, I cannot help with that'));

    await expect(service.generate('Economics', ['excerpt'], 1)).rejects.toThrow(/non-JSON/);
  });

  it('passes an AbortSignal through to generateContent so a hang is bounded', async () => {
    mockGenerateContent.mockResolvedValue(geminiResponse(JSON.stringify([{ front: 'Q', back: 'A' }])));

    await service.generate('Economics', ['excerpt'], 1);

    const [, options] = mockGenerateContent.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  describe('transient 503 retry', () => {
    beforeEach(() => {
      mockGenerateContent.mockReset();
      jest.useFakeTimers();
    });
    afterEach(() => jest.useRealTimers());

    it('retries a transient 503 and returns the eventual success', async () => {
      mockGenerateContent
        .mockRejectedValueOnce(fetchError(503, 'high demand'))
        .mockResolvedValueOnce(geminiResponse(JSON.stringify([{ front: 'Q', back: 'A' }])));

      const promise = service.generate('Economics', ['excerpt'], 1);
      await jest.runAllTimersAsync();

      await expect(promise).resolves.toEqual([{ front: 'Q', back: 'A' }]);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 429 quota error -- rejects immediately', async () => {
      const quotaError = fetchError(429, 'GenerateRequestsPerDayPerProjectPerModel-FreeTier');
      mockGenerateContent.mockRejectedValue(quotaError);

      await expect(service.generate('Economics', ['excerpt'], 1)).rejects.toBe(quotaError);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('retries a Gemini abort/timeout error and returns the eventual success', async () => {
      mockGenerateContent
        .mockRejectedValueOnce(new GoogleGenerativeAIAbortError('Request aborted when fetching'))
        .mockResolvedValueOnce(geminiResponse(JSON.stringify([{ front: 'Q', back: 'A' }])));

      const promise = service.generate('Economics', ['excerpt'], 1);
      await jest.runAllTimersAsync();

      await expect(promise).resolves.toEqual([{ front: 'Q', back: 'A' }]);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });
  });
});
