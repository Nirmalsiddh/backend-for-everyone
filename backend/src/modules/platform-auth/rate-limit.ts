import { createHmac, randomBytes } from 'node:crypto';
import { PlatformAuthError } from './types.js';
export class PlatformRateLimiter {
  private readonly counters = new Map<string, { count: number; expires: number }>();
  private readonly secret = randomBytes(32);
  constructor(private readonly maxEntries = 10000, private readonly now = Date.now) {}
  get size() { return this.counters.size; }
  check(action: 'login' | 'signup', ip: string, email: string) {
    const now = this.now();
    for (const [key, value] of this.counters) if (value.expires <= now) this.counters.delete(key);
    const identifier = createHmac('sha256', this.secret).update(JSON.stringify([ip, email])).digest('hex');
    const rules = action === 'login' ? [[20, 60000], [5, 900000]] : [[5, 900000], [3, 3600000]];
    const keys = [`${action}:ip:${ip}`, `${action}:identifier:${identifier}`];
    for (let i = 0; i < keys.length; i++) {
      const entry = this.counters.get(keys[i]!);
      if (entry && entry.count >= rules[i]![0]!) this.reject(Math.ceil((entry.expires - now) / 1000));
    }
    if (this.counters.size + keys.filter((k) => !this.counters.has(k)).length > this.maxEntries) this.reject(60);
    keys.forEach((key, i) => {
      const entry = this.counters.get(key) ?? { count: 0, expires: now + rules[i]![1]! };
      entry.count++; this.counters.set(key, entry);
    });
  }
  private reject(seconds: number): never {
    throw new PlatformAuthError(429, 'AUTH_RATE_LIMITED', 'Too many authentication attempts', Math.max(1, seconds));
  }
}
