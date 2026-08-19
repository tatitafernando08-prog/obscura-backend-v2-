import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Tracks throttle usage by the authenticated principal's id rather than the
 * default IP-based tracker, per SPEC-SHEET.md §16's "per-admin/day upload
 * rate limit" (multiple admins can plausibly share an IP, or one admin could
 * rotate IPs, so a per-admin cap must key on identity, not network address).
 *
 * Relies on `AuthGuard` (and, on the admin routes this is applied to,
 * `AdminGuard`) having already populated `request.principal` earlier in the
 * guard chain. Falls back to `req.ip` if `principal` is somehow absent so
 * this never throws on a malformed request.
 */
@Injectable()
export class PerPrincipalThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.principal?.id ?? req.ip;
  }
}
