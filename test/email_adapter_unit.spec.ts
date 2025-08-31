import { describe, it, expect, beforeEach } from 'vitest';
import { sendEmail } from '../src/email_adapter';

// Minimal Env + D1 stub sufficient for email_adapter's internal metric increment helper.
class StubStmt { bind() { return this; } async run() { return { success: true }; } async all() { return { results: [] }; } }
class StubDB { prepare(_sql: string) { return new StubStmt(); } async batch(_stmts: any[]) { /* noop */ } }

interface StubEnv {
  DB: any;
  RESEND_API_KEY?: string;
}

let env: StubEnv;

describe('email_adapter sendEmail', () => {
  beforeEach(() => { env = { DB: new StubDB() }; });

  it('returns ok with provider none when no key present', async () => {
    const r = await sendEmail(env as any, 'user@test.dev', 'Hi', '<p>Hi</p>');
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('none');
  });

  it('uses test shortcut when key === "test"', async () => {
    env.RESEND_API_KEY = 'test';
    const r = await sendEmail(env as any, 'user@test.dev', 'Subj', '<b>X</b>');
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('resend');
    expect(r.id).toMatch(/^test-/);
  });

  it('simulates failure when email contains fail', async () => {
    env.RESEND_API_KEY = 'prodkey';
    const r = await sendEmail(env as any, 'fail_case@test.dev', 'Subj', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Simulated failure');
    expect(r.provider_error_code).toBe('sim_fail');
  });

  it('simulates bounce when email contains bounce', async () => {
    env.RESEND_API_KEY = 'prodkey';
    const r = await sendEmail(env as any, 'bounce_case@test.dev', 'Subj', 'x');
    expect(r.ok).toBe(false);
    expect(r.provider_error_code).toBe('bounce');
  });

  it('handles network exception path', async () => {
    env.RESEND_API_KEY = 'prodkey';
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error('network down'); };
    const r = await sendEmail(env as any, 'user@test.dev', 'Subj', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/network down/);
    expect(r.provider_error_code).toBe('exception');
    globalThis.fetch = originalFetch;
  });
});
