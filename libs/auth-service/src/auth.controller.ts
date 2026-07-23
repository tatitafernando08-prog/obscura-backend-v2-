import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { AuthService } from './auth.service';
import { VerifyTokenRequest, VerifyTokenResponse } from '@app/proto/generated/auth';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @GrpcMethod('AuthService', 'VerifyToken')
  async verifyToken(request: VerifyTokenRequest): Promise<VerifyTokenResponse> {
    const principal = await this.authService.resolvePrincipal(request.token);
    if (!principal) {
      return { valid: false, principal: undefined, error: 'invalid_or_expired_token' };
    }
    return { valid: true, principal, error: '' };
  }
}
