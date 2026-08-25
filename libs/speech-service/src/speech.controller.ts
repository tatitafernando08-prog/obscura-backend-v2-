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

// The real runtime shape of `SynthesizeResponse` as serialized by
// @grpc/proto-loader's dynamically-loaded message type, which names this
// field `pcm16_16kMono` -- NOT `pcm1616kMono`, which is what the ts-proto
// `SynthesizeResponse` type below (used only for the method's public
// signature) calls it. See the inline comment on `synthesize()` for the
// full writeup.
interface SynthesizeResponseWireShape {
  success: boolean;
  error: string;
  pcm16_16kMono: Buffer;
}

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
    // Field-name gotcha (see libs/gateway/src/voice/voice.controller.ts for
    // the full writeup): this handler's return value is serialized by
    // @grpc/proto-loader's dynamically-loaded message type, not by ts-proto's
    // generated (de)serializer. proto-loader's own camelCase conversion of
    // `pcm16_16k_mono` produces `pcm16_16kMono` — NOT `pcm1616kMono`, which is
    // what ts-proto's `SynthesizeResponse` type (used here purely for
    // compile-time shape checking) calls the field. Using the ts-proto name
    // here silently serializes the bytes field as empty on the wire, so the
    // object literal must use the real runtime key instead.
    const response: SynthesizeResponseWireShape = {
      success: result.success,
      error: result.error,
      pcm16_16kMono: result.pcm16_16k_mono,
    };
    return response as unknown as SynthesizeResponse;
  }
}
