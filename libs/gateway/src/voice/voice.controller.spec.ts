import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import { VoiceController } from './voice.controller';
import { GatewayAskService } from '../ask/ask.service';
import { SPEECH_GRPC_CLIENT } from '../grpc-clients/speech-client.provider';
import { DeviceAuthGuard } from '../guards/device-auth.guard';
import { ChatSessionsRepository } from '@app/database';

function mockResponse() {
  return {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
    json: jest.fn(),
  } as any;
}

describe('VoiceController', () => {
  const transcribe = jest.fn();
  const synthesize = jest.fn();
  const ask = jest.fn();
  const getOrCreateForDevice = jest.fn();
  const getRecentHistory = jest.fn();
  let controller: VoiceController;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [VoiceController],
      providers: [
        { provide: GatewayAskService, useValue: { ask } },
        { provide: ChatSessionsRepository, useValue: { getOrCreateForDevice, getRecentHistory } },
        { provide: SPEECH_GRPC_CLIENT, useValue: { transcribe, synthesize } },
      ],
    })
      .overrideGuard(DeviceAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(VoiceController);
  });

  beforeEach(() => jest.clearAllMocks());

  it("propagates the request's id into GatewayAskService.ask() the same way ChatController does", async () => {
    transcribe.mockReturnValue(of({ success: true, text: 'what is demand' }));
    synthesize.mockReturnValue(of({ success: true, pcm16_16kMono: Buffer.from('audio') }));
    getOrCreateForDevice.mockResolvedValue('device-session-1');
    getRecentHistory.mockResolvedValue([]);
    ask.mockResolvedValue({ answer: 'The answer', sources: [] });

    const req = {
      device: { deviceId: 'device-1', ownerStudentId: null },
      requestId: 'req-abc-123',
    } as any;

    await controller.ask(
      { buffer: Buffer.from('wav') } as any,
      'Economics',
      'english',
      req,
      mockResponse(),
    );

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-abc-123' }),
    );
  });
});
