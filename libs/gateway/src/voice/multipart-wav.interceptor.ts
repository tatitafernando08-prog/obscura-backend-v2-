import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor, Type, mixin } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable } from 'rxjs';

// A short spoken question at 16kHz/16-bit mono runs roughly 2MB/minute; 10MB
// is a generous ceiling given the voice pipeline's own 25s hard ceiling
// (VoiceController) rules out anything but a short recording in practice.
const MAX_WAV_SIZE_BYTES = 10 * 1024 * 1024;

const RIFF_MAGIC = Buffer.from('RIFF', 'ascii');
const WAVE_MAGIC = Buffer.from('WAVE', 'ascii');

/**
 * Wraps `@nestjs/platform-express`'s `FileInterceptor` (same multipart/multer
 * plumbing Task 55's `PapersUploadController` uses) with a WAV-specific
 * sanity check: the uploaded field must be present and must carry a real
 * RIFF/WAVE header. Mimetype is deliberately not trusted here — it's
 * client-supplied and easy to get wrong/spoof — so this checks the file's
 * actual magic bytes instead.
 *
 * Rejections surface as 400s (via the standard exception layer) before the
 * controller — and therefore before any gRPC calls — ever run.
 */
export function MultipartWavInterceptor(fieldName = 'audio'): Type<NestInterceptor> {
  const BaseFileInterceptor = FileInterceptor(fieldName, { limits: { fileSize: MAX_WAV_SIZE_BYTES } });

  @Injectable()
  class WavValidatingInterceptor extends BaseFileInterceptor {
    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
      const validatingNext: CallHandler = {
        handle: () => {
          const request = context.switchToHttp().getRequest();
          const file: Express.Multer.File | undefined = request.file;

          if (!file || !file.buffer || file.buffer.length < 12) {
            throw new BadRequestException(`'${fieldName}' must be a WAV file`);
          }

          const isRiffWave =
            file.buffer.subarray(0, 4).equals(RIFF_MAGIC) && file.buffer.subarray(8, 12).equals(WAVE_MAGIC);
          if (!isRiffWave) {
            throw new BadRequestException(`'${fieldName}' must be a WAV file (missing RIFF/WAVE header)`);
          }

          return next.handle();
        },
      };

      return super.intercept(context, validatingNext);
    }
  }

  return mixin(WavValidatingInterceptor);
}
