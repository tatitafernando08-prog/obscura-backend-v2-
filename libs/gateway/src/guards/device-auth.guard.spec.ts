import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { DeviceAuthGuard } from './device-auth.guard';
import { AUTH_GRPC_CLIENT } from '../grpc-clients/auth-client.provider';

function mockContext(headers: Record<string, string>): ExecutionContext {
  const request: any = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('DeviceAuthGuard', () => {
  it('throws when no X-Device-Key header is present', async () => {
    const guard = new DeviceAuthGuard({ verifyDeviceKey: jest.fn() } as any);
    await expect(guard.canActivate(mockContext({}))).rejects.toThrow(UnauthorizedException);
  });

  it('throws when the Auth Service reports the device key invalid', async () => {
    const verifyDeviceKey = jest.fn().mockReturnValue(of({ valid: false, error: 'invalid_key' }));
    const guard = new DeviceAuthGuard({ verifyDeviceKey } as any);
    const ctx = mockContext({ 'x-device-key': 'bad-key' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the device to the request and allows access on a valid device key', async () => {
    const device = { deviceId: 'device-1', ownerStudentId: 'student-1' };
    const verifyDeviceKey = jest.fn().mockReturnValue(of({ valid: true, ...device }));
    const guard = new DeviceAuthGuard({ verifyDeviceKey } as any);
    const ctx = mockContext({ 'x-device-key': 'good-key' });

    const allowed = await guard.canActivate(ctx);

    expect(allowed).toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).device).toEqual(device);
  });

  it('propagates gRPC transport errors as UnauthorizedException, not a 500', async () => {
    const verifyDeviceKey = jest.fn().mockReturnValue(throwError(() => new Error('UNAVAILABLE')));
    const guard = new DeviceAuthGuard({ verifyDeviceKey } as any);
    const ctx = mockContext({ 'x-device-key': 'good-key' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
