import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { DatabaseService } from '@app/database';

@Controller('admin/metrics')
@UseGuards(AuthGuard, AdminGuard)
export class MetricsController {
  constructor(private readonly db: DatabaseService) {}

  @Get('citation-rate')
  async citationRate(@Query('days') days = '7') {
    const rows = await this.db.query<{ total: string; grounded_count: string }>(
      `select count(*) filter (where grounded is not null) as total,
              count(*) filter (where grounded = true) as grounded_count
       from chat_messages
       where role = 'assistant' and created_at > now() - ($1 || ' days')::interval`,
      [days],
    );
    const total = Number(rows[0].total);
    const groundedCount = Number(rows[0].grounded_count);
    return {
      grounded_rate: total > 0 ? groundedCount / total : null,
      total_curriculum_responses: total,
    };
  }
}
