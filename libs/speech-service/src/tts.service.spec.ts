import { TtsService } from './tts.service';

const mockSynthesizeSpeech = jest.fn();
jest.mock('@google-cloud/text-to-speech', () => ({
  TextToSpeechClient: jest.fn().mockImplementation(() => ({ synthesizeSpeech: mockSynthesizeSpeech })),
}));

describe('TtsService', () => {
  let service: TtsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TtsService();
  });

  it('requests LINEAR16 / 16kHz mono audio (headerless, robot-firmware-compatible)', async () => {
    mockSynthesizeSpeech.mockResolvedValue([{ audioContent: Buffer.from([1, 2, 3, 4]) }]);
    await service.synthesize('Demand falls as price rises.', 'english');

    const [requestArg] = mockSynthesizeSpeech.mock.calls[0];
    expect(requestArg.audioConfig.audioEncoding).toBe('LINEAR16');
    expect(requestArg.audioConfig.sampleRateHertz).toBe(16000);
    expect(requestArg.voice.languageCode).toBe('en-US');
  });

  it('uses the ta-IN voice for Tamil', async () => {
    mockSynthesizeSpeech.mockResolvedValue([{ audioContent: Buffer.from([1, 2]) }]);
    await service.synthesize('சில உரை', 'tamil');
    const [requestArg] = mockSynthesizeSpeech.mock.calls[0];
    expect(requestArg.voice.languageCode).toBe('ta-IN');
  });

  it('returns the raw PCM buffer on success', async () => {
    const fakePcm = Buffer.from([9, 9, 9]);
    mockSynthesizeSpeech.mockResolvedValue([{ audioContent: fakePcm }]);
    const result = await service.synthesize('hi', 'english');
    expect(result).toEqual({ success: true, pcm16_16k_mono: fakePcm, error: '' });
  });

  it('returns success:false with a clear error for Sinhala (should be routed to the fixed decline message upstream, not synthesized freely)', async () => {
    const result = await service.synthesize('x', 'sinhala');
    expect(result).toEqual({ success: false, pcm16_16k_mono: Buffer.alloc(0), error: 'sinhala_not_supported_on_voice' });
    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
  });
});
