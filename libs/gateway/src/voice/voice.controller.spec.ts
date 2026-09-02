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
      { subject: 'Economics', medium: 'english' },
      req,
      mockResponse(),
    );

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-abc-123' }),
    );
  });

  it('sets X-Question-Text and X-Answer-Text response headers, base64-encoded, on the success path', async () => {
    transcribe.mockReturnValue(of({ success: true, text: 'ඉල්ලුම කියන්නේ මොකක්ද' }));
    synthesize.mockReturnValue(of({ success: true, pcm16_16kMono: Buffer.from('audio') }));
    getOrCreateForDevice.mockResolvedValue('device-session-1');
    getRecentHistory.mockResolvedValue([]);
    ask.mockResolvedValue({ answer: 'ඉල්ලුම යනු මිලකදී භාණ්ඩයක් මිලදී ගැනීමට ඇති කැමැත්තයි', sources: [] });

    const req = { device: { deviceId: 'device-1', ownerStudentId: null }, requestId: 'req-1' } as any;
    const res = mockResponse();

    await controller.ask(
      { buffer: Buffer.from('wav') } as any,
      { subject: 'Economics', medium: 'sinhala' },
      req,
      res,
    );

    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Question-Text',
      Buffer.from('ඉල්ලුම කියන්නේ මොකක්ද', 'utf8').toString('base64'),
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Answer-Text',
      Buffer.from('ඉල්ලුම යනු මිලකදී භාණ්ඩයක් මිලදී ගැනීමට ඇති කැමැත්තයි', 'utf8').toString('base64'),
    );
  });

  it('sets X-Question-Text and X-Answer-Text response headers on the Sinhala-not-supported-on-voice decline path', async () => {
    transcribe.mockReturnValue(of({ success: false, text: '', error: 'sinhala_not_supported_on_voice' }));
    synthesize.mockReturnValue(of({ success: true, pcm16_16kMono: Buffer.from('audio') }));

    const req = { device: { deviceId: 'device-1', ownerStudentId: null }, requestId: 'req-2' } as any;
    const res = mockResponse();

    await controller.ask(
      { buffer: Buffer.from('wav') } as any,
      { subject: undefined, medium: 'sinhala' },
      req,
      res,
    );

    const declineText = "Sorry, voice isn't available in Sinhala yet. Please use the app for Sinhala questions.";
    // STT never transcribes on this path (it declines before that), so the question is empty — still present, so the app can tell "no question captured" from "header missing".
    expect(res.setHeader).toHaveBeenCalledWith('X-Question-Text', '');
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Answer-Text',
      Buffer.from(declineText, 'utf8').toString('base64'),
    );
  });
});
