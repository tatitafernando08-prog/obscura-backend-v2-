import { ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

function mockContext(principal: any) {
  return { switchToHttp: () => ({ getRequest: () => ({ principal }) }) } as any;
}

describe('AdminGuard', () => {
  it('allows a principal with role=admin', () => {
    const guard = new AdminGuard();
    expect(guard.canActivate(mockContext({ role: 'admin' }))).toBe(true);
  });

  it('rejects a principal with role=student', () => {
    const guard = new AdminGuard();
    expect(() => guard.canActivate(mockContext({ role: 'student' }))).toThrow(ForbiddenException);
  });

  it('rejects when no principal is present (AuthGuard did not run first)', () => {
    const guard = new AdminGuard();
    expect(() => guard.canActivate(mockContext(undefined))).toThrow(ForbiddenException);
  });
});
