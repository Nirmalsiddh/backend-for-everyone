import { createHmac, randomBytes } from 'node:crypto';
import { RuntimeError } from '../../runtime/errors.js';
export class AuthRateLimitError extends RuntimeError {
  constructor(public readonly retryAfter: number) { super(429, 'AUTH_RATE_LIMITED', 'Too many authentication attempts'); }
}
export class AuthRateLimiter {
  private readonly counters = new Map<string, { count: number; expires: number }>();
  private readonly secret = randomBytes(32);
  constructor(private readonly windowMs = 60000, private readonly ipLimit = 20, private readonly identifierLimit = 10,
    private readonly maxEntries = 10000, private readonly now = Date.now) {}
  check(projectId: string, action: string, ip: string, email: string) {
    const now = this.now();
    for (const [key, value] of this.counters) if (value.expires <= now) this.counters.delete(key);
    const entries: [string, number][] = [
      [`${projectId}:${action}:ip:${ip}`, this.ipLimit],
      [`${projectId}:${action}:email:${createHmac('sha256', this.secret).update(email).digest('hex')}`, this.identifierLimit],
    ];
    for (const [key, limit] of entries) {
      const entry = this.counters.get(key);
      if (entry && entry.count >= limit) throw new AuthRateLimitError(Math.max(1, Math.ceil((entry.expires - now) / 1000)));
    }
    const needed = entries.filter(([key]) => !this.counters.has(key)).length;
    if (this.counters.size + needed > this.maxEntries) throw new AuthRateLimitError(Math.ceil(this.windowMs / 1000));
    for (const [key] of entries) {
      const entry = this.counters.get(key) ?? { count: 0, expires: now + this.windowMs };
      entry.count++; this.counters.set(key, entry);
    }
  }
}
