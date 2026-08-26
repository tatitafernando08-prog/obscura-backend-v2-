import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database.service';
import { GeminiUsageRepository } from './gemini-usage.repository';

describe('GeminiUsageRepository', () => {
  let db: DatabaseService;
  let repo: GeminiUsageRepository;
  // A unique feature name per test run avoids clashing with any other real
  // feature's row ('chat', 'flashcards', 'ingestion') sharing today's date.
  const feature = `test-feature-${randomUUID()}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, GeminiUsageRepository],
    }).compile();
    db = moduleRef.get(DatabaseService);
    repo = moduleRef.get(GeminiUsageRepository);
  });

  afterAll(async () => {
    await db.query('delete from gemini_daily_usage where feature = $1', [feature]);
  });

  it('reserves a slot and returns true when a feature has never been used today', async () => {
    const reserved = await repo.tryReserveSlot(feature, 5);
    expect(reserved).toBe(true);

    const rows = await db.query<{ request_count: number }>(
      `select request_count from gemini_daily_usage where usage_date = current_date and feature = $1`,
      [feature],
    );
    expect(rows[0].request_count).toBe(1);
  });

  it('keeps incrementing while under the daily limit', async () => {
    await repo.tryReserveSlot(feature, 5); // count now 2 (continuing from the previous test's row)
    const reserved = await repo.tryReserveSlot(feature, 5); // count now 3
    expect(reserved).toBe(true);

    const rows = await db.query<{ request_count: number }>(
      `select request_count from gemini_daily_usage where usage_date = current_date and feature = $1`,
      [feature],
    );
    expect(rows[0].request_count).toBe(3);
  });

  it('returns false and does not increment once the daily limit is reached', async () => {
    const tightFeature = `${feature}-tight`;
    await repo.tryReserveSlot(tightFeature, 1); // count now 1, at the limit
    const reserved = await repo.tryReserveSlot(tightFeature, 1); // would be 2, over the limit of 1

    expect(reserved).toBe(false);

    const rows = await db.query<{ request_count: number }>(
      `select request_count from gemini_daily_usage where usage_date = current_date and feature = $1`,
      [tightFeature],
    );
    expect(rows[0].request_count).toBe(1); // unchanged -- the failed attempt must not have incremented it

    await db.query('delete from gemini_daily_usage where feature = $1', [tightFeature]);
  });

  it('tracks separate features independently under the same date', async () => {
    const featureA = `${feature}-a`;
    const featureB = `${feature}-b`;
    await repo.tryReserveSlot(featureA, 1);
    const reservedB = await repo.tryReserveSlot(featureB, 1);
    expect(reservedB).toBe(true); // featureA being at its limit must not block featureB

    await db.query('delete from gemini_daily_usage where feature in ($1, $2)', [featureA, featureB]);
  });
});
