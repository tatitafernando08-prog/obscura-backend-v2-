import {
  ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  PayloadTooLargeException,
  Post,
  Req,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { DatabaseService, StorageService } from '@app/database';
import { IngestionQueueService } from '@app/ingestion-service';
import { UploadPaperDto } from './dto/upload-paper.dto';

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25MB, per SPEC-SHEET.md §11/§16

/**
 * multer's `limits.fileSize` (set on the FileInterceptor below) aborts the
 * upload stream mid-flight once it's exceeded, which Nest's FileInterceptor
 * surfaces as a `PayloadTooLargeException` (413) rather than the plain 400
 * this controller's own manual `file.size` check returns for the same
 * "file exceeds 25MB limit" condition. Normalize both paths to 400 so
 * callers see one consistent error shape for this validation failure,
 * regardless of whether multer's stream-level cap or the post-buffering
 * fallback check is what caught it.
 */
@Catch(PayloadTooLargeException)
class FileTooLargeFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(400).json({
      statusCode: 400,
      message: 'file exceeds 25MB limit',
      error: 'Bad Request',
    });
  }
}

@Controller('papers')
@UseGuards(AuthGuard, AdminGuard)
export class PapersUploadController {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly queue: IngestionQueueService,
  ) {}

  @Post('upload')
  // 20 uploads/24h per admin (SPEC-SHEET.md §16). Tracked by principal id, not IP,
  // via the 'perAdmin' named throttler set's getTracker (apps/api/src/app.module.ts) —
  // the app-wide APP_GUARD ThrottlerGuard checks every named set on every route, so no
  // route-level guard is needed here; this decorator just tightens 'perAdmin's limit
  // for this route from its harmlessly-high app-wide default down to the real cap.
  @Throttle({ perAdmin: { limit: 20, ttl: 86_400_000 } })
  @UseFilters(FileTooLargeFilter)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SIZE_BYTES } }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadPaperDto,
    @Req() req: Request & { principal: { id: string; role: string; type: string } },
  ) {
    if (!file || file.mimetype !== 'application/pdf') {
      throw new BadRequestException('file must be a PDF');
    }
    if (file.size > MAX_SIZE_BYTES) {
      throw new BadRequestException('file exceeds 25MB limit');
    }

    const paperId = randomUUID();
    const storagePath = `${paperId}.pdf`;

    await this.storage.uploadPdf(storagePath, file.buffer);

    await this.db.query(
      `insert into papers (id, subject, year, syllabus, level, medium, storage_path, status, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'processing', $8)`,
      [paperId, body.subject, body.year ? Number(body.year) : null, body.syllabus ?? null, body.level ?? null, body.medium ?? null, storagePath, req.principal.id],
    );

    await this.queue.enqueue({ paperId });

    return { paper_id: paperId, status: 'processing' };
  }
}
