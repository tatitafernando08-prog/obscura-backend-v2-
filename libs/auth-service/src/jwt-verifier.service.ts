import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as jwksRsa from 'jwks-rsa';
import { EnvConfig } from '@app/common';

/**
 * Verifies Supabase-issued access tokens. Tokens carrying a `kid` are
 * verified against the project's JWKS endpoint (asymmetric RS256/ES256
 * signing keys, the current scheme). Tokens with no `kid` are what a
 * legacy, pre-rotation Supabase token looks like -- signed with the
 * project's shared HS256 secret instead -- and are verified against
 * SUPABASE_JWT_SECRET as a fallback. Both paths exist simultaneously
 * because Supabase key rotation doesn't invalidate sessions signed under
 * the previous scheme until they expire on their own; once the live
 * project's legacy key is fully retired (all such sessions expired), the
 * HS256 fallback and SUPABASE_JWT_SECRET can be removed.
 */
@Injectable()
export class JwtVerifierService {
  private readonly logger = new Logger(JwtVerifierService.name);
  private readonly jwksClient: jwksRsa.JwksClient;
  private readonly legacyJwtSecret?: string;

  constructor(config: ConfigService<EnvConfig, true>) {
    const jwksUri = config.get('SUPABASE_JWKS_URL', { infer: true });
    this.jwksClient = new jwksRsa.JwksClient({ jwksUri });
    this.legacyJwtSecret = config.get('SUPABASE_JWT_SECRET', { infer: true });
  }

  async verify(token: string): Promise<{ sub: string } | null> {
    const decodedHeader = jwt.decode(token, { complete: true });
    const kid = decodedHeader?.header.kid;

    return kid ? this.verifyWithJwks(token, kid) : this.verifyLegacyHs256(token);
  }

  private async verifyWithJwks(token: string, kid: string): Promise<{ sub: string } | null> {
    try {
      const signingKey = await this.jwksClient.getSigningKey(kid);
      const publicKey = signingKey.getPublicKey();

      const decoded = jwt.verify(token, publicKey, {
        algorithms: ['RS256', 'ES256'],
      }) as jwt.JwtPayload;

      if (typeof decoded.sub !== 'string') return null;
      return { sub: decoded.sub };
    } catch (err) {
      const message = (err as Error).message;
      if (/signing key/i.test(message)) {
        // A missing kid almost always means SUPABASE_JWKS_URL points at a
        // different Supabase project than the one that issued the token,
        // not that the token itself is bad -- surface loudly so this isn't
        // mistaken for routine expired/invalid tokens.
        this.logger.warn(`JWT verification failed (signing key lookup): ${message}`);
      } else {
        this.logger.debug(`JWT verification failed: ${message}`);
      }
      return null;
    }
  }

  private verifyLegacyHs256(token: string): { sub: string } | null {
    if (!this.legacyJwtSecret) {
      // Can't even attempt the fallback -- surface loudly rather than let
      // every legacy-signed token look like an ordinary invalid/expired one.
      this.logger.warn(
        'JWT verification failed: no kid in token header and SUPABASE_JWT_SECRET is not configured to attempt legacy verification',
      );
      return null;
    }

    try {
      const decoded = jwt.verify(token, this.legacyJwtSecret, {
        algorithms: ['HS256'],
      }) as jwt.JwtPayload;

      if (typeof decoded.sub !== 'string') return null;
      this.logger.debug('JWT verified via legacy HS256 fallback (no kid in header)');
      return { sub: decoded.sub };
    } catch (err) {
      this.logger.debug(`JWT verification failed (legacy HS256 fallback): ${(err as Error).message}`);
      return null;
    }
  }
}
