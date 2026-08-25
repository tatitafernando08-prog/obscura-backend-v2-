import { Injectable } from '@nestjs/common';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { TTS_LANGUAGE_CODES } from './language';

export interface SynthesizeResult {
  success: boolean;
  pcm16_16k_mono: Buffer;
  error: string;
}

@Injectable()
export class TtsService {
  private readonly client = new TextToSpeechClient();

  async synthesize(text: string, medium: string): Promise<SynthesizeResult> {
    if (medium === 'sinhala') {
      return { success: false, pcm16_16k_mono: Buffer.alloc(0), error: 'sinhala_not_supported_on_voice' };
    }

    const languageCode = TTS_LANGUAGE_CODES[medium] ?? TTS_LANGUAGE_CODES.english;

    let response;
    try {
      [response] = await this.client.synthesizeSpeech({
        input: { text },
        voice: { languageCode, ssmlGender: 'NEUTRAL' as const },
        audioConfig: { audioEncoding: 'LINEAR16' as const, sampleRateHertz: 16000 },
      });
    } catch (err) {
      return { success: false, pcm16_16k_mono: Buffer.alloc(0), error: (err as Error).message };
    }

    return {
      success: true,
      pcm16_16k_mono: Buffer.from(response.audioContent as Uint8Array),
      error: '',
    };
  }
}
