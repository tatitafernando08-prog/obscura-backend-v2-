import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtVerifierService } from './jwt-verifier.service';
import { DeviceKeyService } from './device-key.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtVerifierService, DeviceKeyService],
})
export class AuthServiceModule {}
