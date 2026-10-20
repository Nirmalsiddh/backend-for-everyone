import pg from 'pg';
import { RuntimeError } from '../../runtime/errors.js';
import type { SchemaClient } from './schema-executor.js';
export type Category =
  | 'runtime'
  | 'auth'
  | 'diagnostic'
  | 'schema'
  | 'reconciliation';
export class CustomerAdmission {
  private total = 0;
  private counts: Partial<Record<Category, number>> = {};
  constructor(private readonly maximum = 16) {}
  snapshot() {
    return { total: this.total, categories: { ...this.counts } };
  }
  async acquire(category: Category, waitMs = 250) {
    const until = Date.now() + waitMs;
    const categoryLimit =
      category === 'runtime' || category === 'auth' ? 10 : 2;
    while (
      this.total >= this.maximum ||
      (this.counts[category] ?? 0) >= categoryLimit
    ) {
      if (Date.now() >= until)
        throw new RuntimeError(
          503,
          'CUSTOMER_CAPACITY_EXHAUSTED',
          'Customer database capacity is busy; wait before trying again',
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.total++;
    this.counts[category] = (this.counts[category] ?? 0) + 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.total--;
        this.counts[category]!--;
      }
    };
  }
}
export const customerAdmission = new CustomerAdmission();
export function boundedClient(
  options: pg.ClientConfig,
  category: Category,
  deadlineMs = 10000,
): SchemaClient {
  const raw = new pg.Client(options);
  let release: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let rejectDeadline: (reason: Error) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  // A deadline may fire between queries. Always attach a rejection handler.
  void deadline.catch(() => {});
  const timeout = () =>
    new RuntimeError(
      504,
      'CUSTOMER_OPERATION_TIMEOUT',
      'Customer database operation timed out; inspect state before repeating writes',
    );
  const race = async <T>(work: () => Promise<T>): Promise<T> => {
    if (expired) throw timeout();
    return Promise.race([work(), deadline]);
  };
  return {
    async connect() {
      release = await customerAdmission.acquire(category);
      timer = setTimeout(() => {
        expired = true;
        rejectDeadline(timeout());
        void raw.end().catch(() => {});
      }, deadlineMs);
      try {
        return await race(() => raw.connect());
      } catch (error) {
        if (timer) clearTimeout(timer);
        release();
        throw error;
      }
    },
    query: (text, values) => race(() => raw.query(text, values)),
    on: (_event, listener) => {
      raw.on('error', listener);
    },
    async end() {
      if (timer) clearTimeout(timer);
      try {
        await Promise.race([
          raw.end().catch(() => {}),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1000);
            t.unref();
          }),
        ]);
      } finally {
        release?.();
      }
    },
  };
}
