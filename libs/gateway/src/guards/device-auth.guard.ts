import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { AUTH_GRPC_CLIENT } from '../grpc-clients/auth-client.provider';
import { AuthServiceClient } from '@app/proto/generated/auth';

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_GRPC_CLIENT) private readonly authClient: AuthServiceClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const key: string | undefined = request.headers['x-device-key'];

    if (!key) {
      throw new UnauthorizedException('missing_device_key');
    }

    let response;
    try {
      response = await firstValueFrom(this.authClient.verifyDeviceKey({ key }));
    } catch {
      throw new UnauthorizedException('auth_service_unreachable');
    }

    if (!response.valid) {
      throw new UnauthorizedException(response.error || 'invalid_device_key');
    }

    request.device = { deviceId: response.deviceId, ownerStudentId: response.ownerStudentId || null };
    return true;
  }
}
