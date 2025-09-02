import { describe, it, expect } from 'vitest';
import { sendEmail } from '../src/email_adapter';

class StubStmt { bind() { return this; } async run() { return { success: true }; } async all() { return { results: [] }; } }
class StubDB { prepare(_sql: string) { return new StubStmt(); } async batch(_stmts: any[]) { /* noop */ } }

describe('EMAIL_REAL_SEND feature flag', () => {
  it('simulates when flag not set', async () => {
    const env: any = { DB: new StubDB(), RESEND_API_KEY: 'real_key' };
    const res = await sendEmail(env, 'user@example.com', 'Hi', '<p>Hi</p>');
    expect(res.ok).toBe(true);
    expect(res.id).toMatch(/^sim-/);
  });
  it('attempts real path when flag set (forced fail via pattern)', async () => {
    const env: any = { DB: new StubDB(), RESEND_API_KEY: 'real_key', EMAIL_REAL_SEND: '1' };
    // Force failure path using fail pattern to avoid real network fetch in test
    const res = await sendEmail(env, 'pattern-fail@example.com', 'Hi', '<p>Hi</p>');
    expect(res.ok).toBe(false);
    expect(res.provider_error_code).toBe('forced_fail');
  });
});
