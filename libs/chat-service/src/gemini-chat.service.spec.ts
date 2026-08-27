import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { GeminiChatService } from './gemini-chat.service';

const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  ...jest.requireActual('@google/generative-ai'),
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GoogleGenerativeAIFetchError } = jest.requireActual('@google/generative-ai');

function fetchError(status: number, message: string) {
  return new GoogleGenerativeAIFetchError(message, status, 'Error', undefined);
}

describe('GeminiChatService', () => {
  let service: GeminiChatService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [GeminiChatService],
    }).compile();
    service = moduleRef.get(GeminiChatService);
  });

  it('parses a well-formed structured JSON response', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"answer":"The law of demand says...","is_curriculum_question":true,"cited_indices":[1]}' },
    });
    const result = await service.generate('some prompt');
    expect(result).toEqual({
      answer: 'The law of demand says...',
      isCurriculumQuestion: true,
      citedIndices: [1],
    });
  });

  it('strips markdown code fences if Gemini wraps the JSON in ```json ... ```', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '```json\n{"answer":"hi","is_curriculum_question":false,"cited_indices":[]}\n```' },
    });
    const result = await service.generate('some prompt');
    expect(result.answer).toBe('hi');
  });

  it('throws a clear error if the response is not valid JSON', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'not json at all' } });
    await expect(service.generate('some prompt')).rejects.toThrow(/failed to parse/i);
  });

  it('filters out NaN values from cited_indices if they cannot be converted to numbers', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"answer":"test","is_curriculum_question":false,"cited_indices":[1,"invalid",3]}' },
    });
    const result = await service.generate('some prompt');
    expect(result.citedIndices).toEqual([1, 3]);
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
        .mockResolvedValueOnce({
          response: { text: () => '{"answer":"ok","is_curriculum_question":false,"cited_indices":[]}' },
        });

      const promise = service.generate('some prompt');
      await jest.runAllTimersAsync();

      await expect(promise).resolves.toMatchObject({ answer: 'ok' });
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 429 quota error -- rejects immediately', async () => {
      const quotaError = fetchError(429, 'GenerateRequestsPerDayPerProjectPerModel-FreeTier');
      mockGenerateContent.mockRejectedValue(quotaError);

      await expect(service.generate('some prompt')).rejects.toBe(quotaError);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });
  });
});
