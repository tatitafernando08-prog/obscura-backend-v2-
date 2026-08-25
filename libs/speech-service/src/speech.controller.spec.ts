import { SpeechController } from './speech.controller';
import { SttService } from './stt.service';
import { TtsService } from './tts.service';

describe('SpeechController', () => {
  const transcribe = jest.fn();
  const synthesize = jest.fn();
  let controller: SpeechController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new SpeechController(
      { transcribe } as unknown as SttService,
      { synthesize } as unknown as TtsService,
    );
  });

  it('passes the STT result through unchanged', async () => {
    transcribe.mockResolvedValue({ success: true, text: 'what is demand', error: '' });
    const result = await controller.transcribe({ wavAudio: Buffer.from('wav'), medium: 'english' });
    expect(result).toEqual({ success: true, text: 'what is demand', error: '' });
  });

  it("puts the synthesized audio under the real proto-loader wire key 'pcm16_16kMono', not ts-proto's 'pcm1616kMono'", async () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    synthesize.mockResolvedValue({ success: true, pcm16_16k_mono: pcm, error: '' });

    const result = await controller.synthesize({ text: 'hi', medium: 'english' });

    expect((result as unknown as Record<string, unknown>).pcm16_16kMono).toBe(pcm);
    expect((result as unknown as Record<string, unknown>).pcm1616kMono).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.error).toBe('');
  });
});
