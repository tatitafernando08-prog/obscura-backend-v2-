import { BadRequestException, Body, Controller, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { randomUUID } from 'crypto';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { DatabaseService, StorageService } from '@app/database';
import { IngestionQueueService } from '@app/ingestion-service';
import { UploadPaperDto } from './dto/upload-paper.dto';

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25MB, per SPEC-SHEET.md §11/§16

@Controller('papers')
@UseGuards(AuthGuard, AdminGuard)
export class PapersUploadController {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly queue: IngestionQueueService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
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
