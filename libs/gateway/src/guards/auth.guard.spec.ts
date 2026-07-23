import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { AuthGuard } from './auth.guard';
import { AUTH_GRPC_CLIENT } from '../grpc-clients/auth-client.provider';

function mockContext(headers: Record<string, string>): ExecutionContext {
  const request: any = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  it('throws when no Authorization header is present', async () => {
    const guard = new AuthGuard({ verifyToken: jest.fn() } as any);
    await expect(guard.canActivate(mockContext({}))).rejects.toThrow(UnauthorizedException);
  });

  it('throws when the Auth Service reports the token invalid', async () => {
    const verifyToken = jest.fn().mockReturnValue(of({ valid: false, error: 'bad' }));
    const guard = new AuthGuard({ verifyToken } as any);
    const ctx = mockContext({ authorization: 'Bearer bad-token' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the principal to the request and allows access on a valid token', async () => {
    const principal = { type: 'student', id: 'user-1', role: 'student' };
    const verifyToken = jest.fn().mockReturnValue(of({ valid: true, principal }));
    const guard = new AuthGuard({ verifyToken } as any);
    const ctx = mockContext({ authorization: 'Bearer good-token' });

    const allowed = await guard.canActivate(ctx);

    expect(allowed).toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).principal).toEqual(principal);
  });

  it('propagates gRPC transport errors as UnauthorizedException, not a 500', async () => {
    const verifyToken = jest.fn().mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    const guard = new AuthGuard({ verifyToken } as any);
    const ctx = mockContext({ authorization: 'Bearer good-token' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
