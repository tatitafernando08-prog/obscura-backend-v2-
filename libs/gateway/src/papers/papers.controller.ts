import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { DatabaseService } from '@app/database';

/**
 * Read-only sibling to `PapersUploadController` (Task 55): same `papers`
 * route prefix, but gated by `AuthGuard` alone (any authenticated student)
 * rather than `AuthGuard` + `AdminGuard`, since reading paper status/list
 * doesn't need elevated privileges. Kept as a separate controller class per
 * that separation of concerns; Nest allows both to share the `papers`
 * prefix because the concrete paths (`upload` vs `:id`/``) don't collide.
 */
@Controller('papers')
@UseGuards(AuthGuard)
export class PapersController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list() {
    const rows = await this.db.query(
      `select id as paper_id, subject, year, syllabus, level, medium, status
       from papers order by created_at desc limit 100`,
    );
    return { papers: rows };
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const rows = await this.db.query<{
      paper_id: string; subject: string; year: number | null; status: string;
    }>(
      `select p.id as paper_id, p.subject, p.year, p.status,
              (select count(*) from paper_chunks pc where pc.paper_id = p.id) as chunk_count
       from papers p where p.id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('paper_not_found');
    return rows[0];
  }
}
