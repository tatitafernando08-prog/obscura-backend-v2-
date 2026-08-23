import { SttService } from './stt.service';

const mockRecognize = jest.fn();
jest.mock('@google-cloud/speech', () => ({
  SpeechClient: jest.fn().mockImplementation(() => ({ recognize: mockRecognize })),
}));

describe('SttService', () => {
  let service: SttService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SttService();
  });

  it('rejects Sinhala before calling Google Speech at all', async () => {
    const result = await service.transcribe(Buffer.from('fake wav'), 'sinhala');
    expect(result).toEqual({
      success: false,
      text: '',
      error: 'sinhala_not_supported_on_voice',
    });
    expect(mockRecognize).not.toHaveBeenCalled();
  });

  it('transcribes English audio using the en-US language code', async () => {
    mockRecognize.mockResolvedValue([{ results: [{ alternatives: [{ transcript: 'what is the law of demand' }] }] }]);
    const result = await service.transcribe(Buffer.from('fake wav'), 'english');
    expect(result).toEqual({ success: true, text: 'what is the law of demand', error: '' });
    expect(mockRecognize.mock.calls[0][0].config.languageCode).toBe('en-US');
  });

  it('transcribes Tamil audio using the ta-IN language code', async () => {
    mockRecognize.mockResolvedValue([{ results: [{ alternatives: [{ transcript: 'tamil text' }] }] }]);
    const result = await service.transcribe(Buffer.from('fake wav'), 'tamil');
    expect(result.success).toBe(true);
    expect(mockRecognize.mock.calls[0][0].config.languageCode).toBe('ta-IN');
  });

  it('returns success:false with a clear error when Google returns no results (silence)', async () => {
    mockRecognize.mockResolvedValue([{ results: [] }]);
    const result = await service.transcribe(Buffer.from('fake wav'), 'english');
    expect(result).toEqual({ success: false, text: '', error: 'no_speech_detected' });
  });
});
