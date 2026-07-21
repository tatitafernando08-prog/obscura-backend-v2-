import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DatabaseService } from './database.service';

describe('DatabaseService', () => {
  let service: DatabaseService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService],
    }).compile();
    service = moduleRef.get(DatabaseService);
  });

  it('runs a trivial query against the real dev database', async () => {
    const rows = await service.query<{ answer: number }>('select 1 + 1 as answer');
    expect(rows[0].answer).toBe(2);
  });
});
