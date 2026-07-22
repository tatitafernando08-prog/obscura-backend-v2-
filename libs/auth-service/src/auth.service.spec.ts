import { Test } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { JwtVerifierService } from './jwt-verifier.service';
import { StudentsRepository } from '@app/database';

jest.mock('jwks-rsa', () => ({
  JwksClient: jest.fn().mockImplementation(() => ({
    getSigningKey: jest.fn(),
  })),
}));

describe('AuthService', () => {
  let service: AuthService;
  const verify = jest.fn();
  const findById = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: JwtVerifierService, useValue: { verify } },
        { provide: StudentsRepository, useValue: { findById } },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  beforeEach(() => jest.clearAllMocks());

  it('returns null when the token is invalid', async () => {
    verify.mockResolvedValue(null);
    const result = await service.resolvePrincipal('bad-token');
    expect(result).toBeNull();
  });

  it('returns null when the token is valid but no matching student row exists', async () => {
    verify.mockResolvedValue({ sub: 'user-1' });
    findById.mockResolvedValue(null);
    const result = await service.resolvePrincipal('valid-token');
    expect(result).toBeNull();
  });

  it('resolves a student principal for a valid token with a student role', async () => {
    verify.mockResolvedValue({ sub: 'user-1' });
    findById.mockResolvedValue({ id: 'user-1', role: 'student' });
    const result = await service.resolvePrincipal('valid-token');
    expect(result).toEqual({ type: 'student', id: 'user-1', role: 'student' });
  });

  it('resolves an admin principal for a valid token with an admin role', async () => {
    verify.mockResolvedValue({ sub: 'user-2' });
    findById.mockResolvedValue({ id: 'user-2', role: 'admin' });
    const result = await service.resolvePrincipal('valid-token');
    expect(result).toEqual({ type: 'admin', id: 'user-2', role: 'admin' });
  });
});
