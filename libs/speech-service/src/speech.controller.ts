import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { SttService } from './stt.service';
import { TtsService } from './tts.service';
import {
  TranscribeRequest,
  TranscribeResponse,
  SynthesizeRequest,
  SynthesizeResponse,
} from '@app/proto/generated/speech';

@Controller()
export class SpeechController {
  constructor(
    private readonly stt: SttService,
    private readonly tts: TtsService,
  ) {}

  @GrpcMethod('SpeechService', 'Transcribe')
  async transcribe(request: TranscribeRequest): Promise<TranscribeResponse> {
    const result = await this.stt.transcribe(
      Buffer.from(request.wavAudio),
      request.medium,
    );
    return { success: result.success, text: result.text, error: result.error };
  }

  @GrpcMethod('SpeechService', 'Synthesize')
  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResponse> {
    const result = await this.tts.synthesize(request.text, request.medium);
    return {
      success: result.success,
      pcm1616kMono: result.pcm16_16k_mono,
      error: result.error,
    };
  }
}
