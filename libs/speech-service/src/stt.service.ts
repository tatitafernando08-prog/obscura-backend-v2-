import { Injectable } from '@nestjs/common';
import { SpeechClient } from '@google-cloud/speech';
import { STT_LANGUAGE_CODES } from './language';

export interface TranscribeResult {
  success: boolean;
  text: string;
  error: string;
}

@Injectable()
export class SttService {
  private readonly client = new SpeechClient();

  async transcribe(wavAudio: Buffer, medium: string): Promise<TranscribeResult> {
    if (medium === 'sinhala') {
      return { success: false, text: '', error: 'sinhala_not_supported_on_voice' };
    }

    const languageCode = STT_LANGUAGE_CODES[medium] ?? STT_LANGUAGE_CODES.english;

    let response;
    try {
      [response] = await this.client.recognize({
        audio: { content: wavAudio.toString('base64') },
        config: {
          encoding: 'LINEAR16' as const,
          sampleRateHertz: 16000,
          languageCode,
        },
      });
    } catch (err) {
      return { success: false, text: '', error: (err as Error).message };
    }

    const transcript = response.results?.[0]?.alternatives?.[0]?.transcript;
    if (!transcript) {
      return { success: false, text: '', error: 'no_speech_detected' };
    }

    return { success: true, text: transcript, error: '' };
  }
}
