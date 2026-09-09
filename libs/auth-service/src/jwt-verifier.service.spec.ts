import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { JwtVerifierService } from './jwt-verifier.service';

const mockGetSigningKey = jest.fn();

jest.mock('jwks-rsa', () => ({
  JwksClient: jest.fn().mockImplementation(() => ({
    getSigningKey: mockGetSigningKey,
  })),
}));

describe('JwtVerifierService', () => {
  let service: JwtVerifierService;

  // Local keypair standing in for Supabase's real signing key. Signing with
  // this (and mocking jwks-rsa to hand back its public half for kid
  // 'test-key-1') lets us test real RS256 verification without any network
  // call to the real JWKS endpoint.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // A second, unrelated keypair used to simulate a forged/wrong-key token:
  // signed with a key the mocked JWKS client does NOT recognize as valid
  // for the kid it claims.
  const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const JWKS_URL = 'https://nyenklkwgmcvwllolkeu.supabase.co/auth/v1/.well-known/jwks.json';
  const LEGACY_SECRET = 'test-legacy-shared-secret';

  function fakeConfig(legacySecret?: string) {
    return {
      get: (key: string) => {
        if (key === 'SUPABASE_JWKS_URL') return JWKS_URL;
        if (key === 'SUPABASE_JWT_SECRET') return legacySecret;
        return undefined;
      },
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [
        JwtVerifierService,
        { provide: ConfigService, useValue: fakeConfig(LEGACY_SECRET) },
      ],
    }).compile();
    service = moduleRef.get(JwtVerifierService);
  });

  beforeEach(() => {
    mockGetSigningKey.mockReset();
    mockGetSigningKey.mockImplementation(async (kid: string) => {
      if (kid === 'test-key-1') {
        return { getPublicKey: () => publicKey };
      }
      throw new Error(`Unknown kid: ${kid}`);
    });
  });

  it('accepts a validly signed, unexpired token and returns its sub claim', async () => {
    const token = jwt.sign(
      { sub: 'user-123', role: 'authenticated' },
      privateKey,
      { algorithm: 'RS256', keyid: 'test-key-1', expiresIn: '1h' },
    );

    const result = await service.verify(token);

    expect(result).toEqual({ sub: 'user-123' });
  });

  it('rejects a token signed with a different keypair', async () => {
    // Same kid as the trusted key, but signed with an unrelated private key
    // -- the mock still resolves 'test-key-1' to the trusted public key, so
    // signature verification must fail.
    const token = jwt.sign({ sub: 'user-123' }, wrongPrivateKey, {
      algorithm: 'RS256',
      keyid: 'test-key-1',
      expiresIn: '1h',
    });

    const result = await service.verify(token);

    expect(result).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = jwt.sign({ sub: 'user-123' }, privateKey, {
      algorithm: 'RS256',
      keyid: 'test-key-1',
      expiresIn: '-1h',
    });

    const result = await service.verify(token);

    expect(result).toBeNull();
  });

  it('falls back to legacy HS256 verification and accepts a validly signed token with no kid', async () => {
    // No `keyid` option -- this is what a legacy, pre-rotation Supabase
    // token looks like: HS256-signed against the shared secret, no kid.
    const token = jwt.sign({ sub: 'user-123' }, LEGACY_SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });

    const result = await service.verify(token);

    expect(result).toEqual({ sub: 'user-123' });
  });

  it('rejects a legacy HS256 token signed with the wrong secret', async () => {
    const token = jwt.sign({ sub: 'user-123' }, 'not-the-real-secret', {
      algorithm: 'HS256',
      expiresIn: '1h',
    });

    const result = await service.verify(token);

    expect(result).toBeNull();
  });

  it('rejects an expired legacy HS256 token', async () => {
    const token = jwt.sign({ sub: 'user-123' }, LEGACY_SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1h',
    });

    const result = await service.verify(token);

    expect(result).toBeNull();
  });

  it('warns loudly, rather than failing silently, when a token has no kid and SUPABASE_JWT_SECRET is not configured', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [
        JwtVerifierService,
        { provide: ConfigService, useValue: fakeConfig(undefined) },
      ],
    }).compile();
    const serviceWithoutLegacySecret = moduleRef.get(JwtVerifierService);

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const token = jwt.sign({ sub: 'user-123' }, LEGACY_SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });

    const result = await serviceWithoutLegacySecret.verify(token);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/no kid.*SUPABASE_JWT_SECRET|SUPABASE_JWT_SECRET.*not configured/i));
    warnSpy.mockRestore();
  });
});
