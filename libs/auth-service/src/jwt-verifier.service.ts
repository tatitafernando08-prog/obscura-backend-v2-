import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as jwksRsa from 'jwks-rsa';
import { EnvConfig } from '@app/common';

/**
 * Verifies Supabase-issued access tokens against the project's JWKS
 * endpoint (asymmetric signing keys), rather than a shared HS256 secret.
 * Supabase's newer "JWT signing keys" projects rotate/publish public keys
 * via SUPABASE_JWKS_URL and sign with RS256 or ES256 depending on project
 * configuration -- both are accepted here since the JWKS is the trusted
 * source of truth; verification only succeeds if the token's signature is
 * actually valid for the key/algorithm it claims.
 */
@Injectable()
export class JwtVerifierService {
  private readonly logger = new Logger(JwtVerifierService.name);
  private readonly jwksClient: jwksRsa.JwksClient;

  constructor(config: ConfigService<EnvConfig, true>) {
    const jwksUri = config.get('SUPABASE_JWKS_URL', { infer: true });
    this.jwksClient = new jwksRsa.JwksClient({ jwksUri });
  }

  async verify(token: string): Promise<{ sub: string } | null> {
    try {
      const decodedHeader = jwt.decode(token, { complete: true });
      const kid = decodedHeader?.header.kid;
      if (!kid) return null;

      const signingKey = await this.jwksClient.getSigningKey(kid);
      const publicKey = signingKey.getPublicKey();

      const decoded = jwt.verify(token, publicKey, {
        algorithms: ['RS256', 'ES256'],
      }) as jwt.JwtPayload;

      if (typeof decoded.sub !== 'string') return null;
      return { sub: decoded.sub };
    } catch (err) {
      this.logger.debug(`JWT verification failed: ${(err as Error).message}`);
      return null;
    }
  }
}
