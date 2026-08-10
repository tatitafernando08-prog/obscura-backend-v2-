import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import { GatewayAskService } from './ask.service';
import { RAG_GRPC_CLIENT } from '../grpc-clients/rag-client.provider';
import { CHAT_GRPC_CLIENT } from '../grpc-clients/chat-client.provider';
import { ChatSessionsRepository } from '@app/database';

describe('GatewayAskService', () => {
  const search = jest.fn();
  const ask = jest.fn();
  const appendMessage = jest.fn();
  let service: GatewayAskService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        GatewayAskService,
        { provide: RAG_GRPC_CLIENT, useValue: { search } },
        { provide: CHAT_GRPC_CLIENT, useValue: { ask } },
        { provide: ChatSessionsRepository, useValue: { appendMessage } },
      ],
    }).compile();
    service = moduleRef.get(GatewayAskService);
  });

  beforeEach(() => jest.clearAllMocks());

  it('calls RAG Search then Chat Ask, passing retrieved chunks through', async () => {
    search.mockReturnValue(of({ chunks: [{ chunkId: 'c1', paperId: 'p1', content: 'x', subject: 'Economics', year: 2022, questionNumber: '', page: 0, relevanceScore: 0.9 }] }));
    ask.mockReturnValue(of({ answer: 'The answer', sources: [{ subject: 'Economics', year: '2022' }], grounded: true }));

    const result = await service.ask({
      questionText: 'what is demand',
      subject: 'Economics',
      syllabus: 'local',
      medium: 'english',
      history: [],
      sessionId: 'test-session',
    });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'what is demand', subject: 'Economics' }));
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      questionText: 'what is demand',
      retrievedChunks: expect.arrayContaining([expect.objectContaining({ chunkId: 'c1' })]),
    }));
    expect(result).toEqual({ answer: 'The answer', sources: [{ subject: 'Economics', year: '2022' }] });
    expect(appendMessage).toHaveBeenCalledTimes(2);
    expect(appendMessage).toHaveBeenNthCalledWith(1, 'test-session', 'user', 'what is demand');
    expect(appendMessage).toHaveBeenNthCalledWith(2, 'test-session', 'assistant', 'The answer', [{ subject: 'Economics', year: '2022' }]);
  });

  it('still calls Chat Ask with an empty chunk list when RAG finds nothing (small talk path)', async () => {
    search.mockReturnValue(of({ chunks: [] }));
    ask.mockReturnValue(of({ answer: 'Hi! I can help with...', sources: [], grounded: true }));

    const result = await service.ask({ questionText: 'hi', medium: 'english', history: [], sessionId: 'test-session' });

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ retrievedChunks: [] }));
    expect(result.sources).toEqual([]);
    expect(appendMessage).toHaveBeenCalledTimes(2);
  });
});
