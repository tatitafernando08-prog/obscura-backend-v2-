import { Controller, Inject, Logger, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Request, Response } from 'express';
import { firstValueFrom } from 'rxjs';
import { DeviceAuthGuard } from '../guards/device-auth.guard';
import { GatewayAskService } from '../ask/ask.service';
import { ChatSessionsRepository } from '@app/database';
import { SPEECH_GRPC_CLIENT } from '../grpc-clients/speech-client.provider';
import { SpeechServiceClient } from '@app/proto/generated/speech';
import { MultipartWavInterceptor } from './multipart-wav.interceptor';

const VOICE_PIPELINE_HARD_CEILING_MS = 25_000;

type DeviceAuthedRequest = Request & {
  device: { deviceId: string; ownerStudentId: string | null };
  requestId?: string;
};

/**
 * Google Cloud Text-to-Speech's `LINEAR16` encoding (used by Task 41's
 * `TtsService`) always wraps its samples in a standard WAV container —
 * there's no "raw PCM" encoding option in that API — so `SynthesizeResponse`
 * actually carries a full RIFF/WAVE file, header included. This endpoint's
 * own contract (`iot-robot-README.md` §5) is "raw headerless PCM out", so
 * the header has to be stripped here rather than passed through as-is.
 * Walks chunks (rather than assuming the header is always a fixed 44 bytes)
 * since some encoders emit extra chunks (e.g. "fact") before "data".
 */
function stripWavHeaderIfPresent(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return buf; // not WAV-wrapped (or empty) — already headerless, pass through
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === 'data') {
      return buf.subarray(dataStart, dataStart + chunkSize);
    }
    offset = dataStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  return buf; // no "data" chunk found; fall back to the whole buffer
}

/**
 * Handles the ESP32 firmware's `POST /voice/ask` (iot-robot-README.md §5):
 * multipart WAV in, raw headerless PCM out. Auth is per-device (Task 43's
 * `DeviceAuthGuard`, keyed off `X-Device-Key`) rather than per-student JWT —
 * the firmware doesn't hold a student session, only its provisioned device key.
 */
@Controller('voice')
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);

  constructor(
    private readonly askService: GatewayAskService,
    private readonly chatSessions: ChatSessionsRepository,
    @Inject(SPEECH_GRPC_CLIENT) private readonly speechClient: SpeechServiceClient,
  ) {}

  @Post('ask')
  @UseGuards(DeviceAuthGuard)
  @UseInterceptors(MultipartWavInterceptor('audio'))
  async ask(
    @UploadedFile() audio: Express.Multer.File,
    @Query('subject') subject: string | undefined,
    @Query('medium') medium: string,
    @Req() req: DeviceAuthedRequest,
    @Res() res: Response,
  ) {
    const stageTimings: Record<string, number> = {};
    const start = Date.now();

    const transcribeResult = await firstValueFrom(
      this.speechClient.transcribe({ wavAudio: audio.buffer, medium }),
    );
    stageTimings.stt = Date.now() - start;

    if (!transcribeResult.success) {
      if (transcribeResult.error === 'sinhala_not_supported_on_voice') {
        const declineText = "Sorry, voice isn't available in Sinhala yet. Please use the app for Sinhala questions.";
        const synth = await firstValueFrom(this.speechClient.synthesize({ text: declineText, medium: 'english' }));
        res.setHeader('Content-Type', 'application/octet-stream');
        // Use the same field-name-corrected extraction as the success path (see comment below)
        const pcm = (synth as unknown as Record<string, Uint8Array>)['pcm16_16kMono'];
        return res.status(200).send(stripWavHeaderIfPresent(Buffer.from(pcm)));
      }
      this.logger.warn(`Transcribe failed: ${transcribeResult.error}`);
      return res.status(422).json({ error: transcribeResult.error });
    }

    const sessionId = await this.chatSessions.getOrCreateForDevice(req.device.deviceId);
    const history = await this.chatSessions.getRecentHistory(sessionId, 6);

    const askStart = Date.now();
    const askResult = await this.askService.ask({
      questionText: transcribeResult.text,
      subject,
      medium,
      history,
      sessionId,
      requestId: req.requestId,
    });
    stageTimings.ask = Date.now() - askStart;

    const ttsStart = Date.now();
    const synthResult = await firstValueFrom(
      this.speechClient.synthesize({ text: askResult.answer, medium }),
    );
    stageTimings.tts = Date.now() - ttsStart;

    const totalMs = Date.now() - start;
    this.logger.log(`voice/ask stage timings: ${JSON.stringify(stageTimings)}, total=${totalMs}ms`);
    if (totalMs > VOICE_PIPELINE_HARD_CEILING_MS) {
      this.logger.error(`voice/ask exceeded the 25s hard ceiling: ${totalMs}ms`);
    }

    if (!synthResult.success) {
      return res.status(422).json({ error: synthResult.error });
    }

    // Nest presets the response status to 201 (its default for POST) before
    // this handler runs, since it's still tracked via `RouterExecutionContext`
    // even though @Res() hands off response-sending to us directly. Explicit
    // 200 here overrides that default for the actual success case.
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    // Field-name gotcha (discovered running this controller's own e2e test):
    // the compile-time `SpeechServiceClient` type from ts-proto names this
    // field `pcm1616kMono` (ts-proto's own camelCase conversion of
    // `pcm16_16k_mono`). But this client is a *dynamically loaded*
    // `@grpc/proto-loader` client (see speech-client.provider.ts), and
    // proto-loader runs its own, differently-behaved camelCase conversion
    // over the same proto — for this field it produces `pcm16_16kMono`
    // (verified: `loader.loadSync(...).type.field` for `SynthesizeResponse`).
    // The two names diverge only because `16k` puts a digit directly after
    // the underscore; `wavAudio`/`text`/`medium` elsewhere aren't affected.
    // ts-proto's type is therefore wrong for this one field's *runtime*
    // shape, so read it by the real runtime key rather than the typed one.
    const pcm = (synthResult as unknown as Record<string, Uint8Array>)['pcm16_16kMono'];
    res.send(stripWavHeaderIfPresent(Buffer.from(pcm)));
  }
}
