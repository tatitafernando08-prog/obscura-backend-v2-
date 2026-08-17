import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { randomBytes } from 'crypto';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { DatabaseService } from '@app/database';
import { DeviceKeyService } from '@app/auth-service';

class CreateDeviceDto {
  @IsOptional() @IsString()
  label?: string;

  @IsOptional() @IsUUID()
  owner_student_id?: string;
}

@Controller('admin/devices')
@UseGuards(AuthGuard, AdminGuard)
export class AdminDevicesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly deviceKeys: DeviceKeyService,
  ) {}

  @Post()
  async create(@Body() body: CreateDeviceDto) {
    const plaintextKey = randomBytes(24).toString('hex');
    const hash = await this.deviceKeys.hashKey(plaintextKey);

    const rows = await this.db.query<{ id: string }>(
      `insert into devices (api_key_hash, label, owner_student_id) values ($1, $2, $3) returning id`,
      [hash, body.label ?? null, body.owner_student_id ?? null],
    );

    return { device_id: rows[0].id, api_key: plaintextKey };
  }
}
