import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '@app/database';
import { DeviceKeyService } from './device-key.service';

describe('DeviceKeyService (integration, real dev DB)', () => {
  let db: DatabaseService;
  let service: DeviceKeyService;
  let deviceId: string;
  let plaintextKey: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, DeviceKeyService],
    }).compile();
    db = moduleRef.get(DatabaseService);
    service = moduleRef.get(DeviceKeyService);

    plaintextKey = `test-key-${randomUUID()}`;
    const hash = await service.hashKey(plaintextKey);
    const rows = await db.query<{ id: string }>(
      `insert into devices (api_key_hash, label) values ($1, 'test device') returning id`,
      [hash],
    );
    deviceId = rows[0].id;
  });

  afterAll(async () => {
    await db.query('delete from devices where id = $1', [deviceId]);
  });

  it('resolves a valid key to its device id', async () => {
    const result = await service.verifyKey(plaintextKey);
    expect(result).toEqual({ deviceId, ownerStudentId: null });
  });

  it('rejects an unknown key', async () => {
    const result = await service.verifyKey('not-a-real-key');
    expect(result).toBeNull();
  });

  it('rejects a revoked key', async () => {
    await db.query('update devices set revoked_at = now() where id = $1', [deviceId]);
    const result = await service.verifyKey(plaintextKey);
    expect(result).toBeNull();
    await db.query('update devices set revoked_at = null where id = $1', [deviceId]); // restore for other tests
  });
});
