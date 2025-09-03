// Lightweight retry wrapper to mitigate transient 'Network connection lost' issues in Workers test pool.
// Retries idempotent requests (GET, HEAD) and safe POSTs used in tests that can be repeated without side effects.

export async function fetchRetry(input: string, init?: RequestInit & { retry?: number, retryDelayMs?: number }) {
  const max = init?.retry ?? 2;
  const delay = init?.retryDelayMs ?? 75;
  let attempt = 0;
  // Clone basic properties without retry-specific config
  const { retry, retryDelayMs, ...rest } = init || {} as any;
  while (true) {
    try {
      const res = await (globalThis as any).SELF.fetch(input, rest);
      return res;
    } catch (e: any) {
      const msg = String(e || '');
      if (attempt >= max || !/Network connection lost/i.test(msg)) throw e;
      await new Promise(r => setTimeout(r, delay * (attempt + 1)));
      attempt++;
    }
  }
}
