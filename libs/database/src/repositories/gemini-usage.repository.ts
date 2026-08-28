import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

@Injectable()
export class GeminiUsageRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Atomically checks today's usage for `feature` against `dailyLimit` and
   * increments it in the same statement -- race-safe under concurrent
   * requests (the `where` clause on the UPDATE half of the upsert means a
   * losing concurrent request simply updates zero rows instead of both
   * requests reading a stale count before either writes).
   */
  async tryReserveSlot(feature: string, dailyLimit: number): Promise<boolean> {
    const rows = await this.db.query<{ request_count: number }>(
      `insert into gemini_daily_usage (usage_date, feature, request_count, daily_limit)
       values (current_date, $1, 1, $2)
       on conflict (usage_date, feature) do update
         set request_count = gemini_daily_usage.request_count + 1
         where gemini_daily_usage.request_count < gemini_daily_usage.daily_limit
       returning request_count`,
      [feature, dailyLimit],
    );
    return rows.length > 0;
  }

  /**
   * Gives back a slot reserved by `tryReserveSlot` -- call this when the
   * downstream Gemini call the slot was reserved for ends up failing, so a
   * failure doesn't permanently cost part of the feature's daily budget.
   */
  async releaseSlot(feature: string): Promise<void> {
    await this.db.query(
      `update gemini_daily_usage
       set request_count = greatest(request_count - 1, 0)
       where usage_date = current_date and feature = $1`,
      [feature],
    );
  }
}
