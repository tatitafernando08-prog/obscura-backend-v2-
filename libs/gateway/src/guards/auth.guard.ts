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
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_GRPC_CLIENT) private readonly authClient: AuthServiceClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      throw new UnauthorizedException('missing_bearer_token');
    }

    let response;
    try {
      response = await firstValueFrom(this.authClient.verifyToken({ token }));
    } catch {
      throw new UnauthorizedException('auth_service_unreachable');
    }

    if (!response.valid || !response.principal) {
      throw new UnauthorizedException(response.error || 'invalid_token');
    }

    request.principal = response.principal;
    return true;
  }
}
