import { Test } from '@nestjs/testing';
import { ChatLlmAskService } from './ask.service';
import { GeminiChatService } from './gemini-chat.service';

describe('ChatLlmAskService', () => {
  let service: ChatLlmAskService;
  const generate = jest.fn();

  const chunks = [
    { index: 1, content: 'law of demand text', subject: 'Economics', year: 2022 },
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ChatLlmAskService, { provide: GeminiChatService, useValue: { generate } }],
    }).compile();
    service = moduleRef.get(ChatLlmAskService);
  });

  beforeEach(() => jest.clearAllMocks());

  it('resolves cited_indices back to real chunk subject/year, not whatever Gemini said', async () => {
    generate.mockResolvedValue({
      answer: 'Demand falls as price rises.',
      isCurriculumQuestion: true,
      citedIndices: [1],
    });

    const result = await service.ask({ questionText: 'q', medium: 'english', history: [], chunks });

    expect(result.sources).toEqual([{ subject: 'Economics', year: '2022' }]);
    expect(result.grounded).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not require sources for small-talk questions', async () => {
    generate.mockResolvedValue({ answer: 'I can help with your studies!', isCurriculumQuestion: false, citedIndices: [] });

    const result = await service.ask({ questionText: 'what can you help with', medium: 'english', history: [], chunks: [] });

    expect(result.sources).toEqual([]);
    expect(result.grounded).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('retries once with a stricter prompt when a curriculum question gets zero citations', async () => {
    generate
      .mockResolvedValueOnce({ answer: 'Some hallucinated answer', isCurriculumQuestion: true, citedIndices: [] })
      .mockResolvedValueOnce({ answer: "I don't have that in the past papers I have yet.", isCurriculumQuestion: true, citedIndices: [] });

    const result = await service.ask({ questionText: 'q', medium: 'english', history: [], chunks });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.answer).toMatch(/don't have that/i);
    expect(result.sources).toEqual([]);
    expect(result.grounded).toBe(false);
  });

  it('marks grounded=true if the retry succeeds in producing a citation', async () => {
    generate
      .mockResolvedValueOnce({ answer: 'hallucinated', isCurriculumQuestion: true, citedIndices: [] })
      .mockResolvedValueOnce({ answer: 'grounded answer', isCurriculumQuestion: true, citedIndices: [1] });

    const result = await service.ask({ questionText: 'q', medium: 'english', history: [], chunks });

    expect(result.grounded).toBe(true);
    expect(result.sources).toEqual([{ subject: 'Economics', year: '2022' }]);
  });

  it('retries when curriculum question cites a non-existent chunk index', async () => {
    generate
      .mockResolvedValueOnce({ answer: 'hallucinated answer with fake citation', isCurriculumQuestion: true, citedIndices: [99] })
      .mockResolvedValueOnce({ answer: "I don't have that information.", isCurriculumQuestion: true, citedIndices: [] });

    const result = await service.ask({ questionText: 'q', medium: 'english', history: [], chunks });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.answer).toMatch(/don't have that/i);
    expect(result.sources).toEqual([]);
    expect(result.grounded).toBe(false);
  });
});
