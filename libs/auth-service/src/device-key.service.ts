import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from '@app/database';

const SALT_ROUNDS = 12;

export interface DeviceKeyMatch {
  deviceId: string;
  ownerStudentId: string | null;
}

interface DeviceRow {
  id: string;
  api_key_hash: string;
  owner_student_id: string | null;
}

@Injectable()
export class DeviceKeyService {
  constructor(private readonly db: DatabaseService) {}

  async hashKey(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, SALT_ROUNDS);
  }

  async verifyKey(plaintext: string): Promise<DeviceKeyMatch | null> {
    // bcrypt hashes can't be looked up by equality, so this checks every
    // non-revoked device's hash. Fine at this corpus's scale (<20 devices,
    // SPEC-SHEET.md §8); revisit with a fast lookup prefix if the device
    // fleet ever grows into the hundreds.
    const devices = await this.db.query<DeviceRow>(
      `select id, api_key_hash, owner_student_id from devices where revoked_at is null`,
    );

    for (const device of devices) {
      if (await bcrypt.compare(plaintext, device.api_key_hash)) {
        await this.db.query('update devices set last_seen_at = now() where id = $1', [device.id]);
        return { deviceId: device.id, ownerStudentId: device.owner_student_id };
      }
    }
    return null;
  }
}
