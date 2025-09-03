// src/email_adapter.ts
// Pluggable email sending abstraction. Uses Resend if RESEND_API_KEY present.

import type { Env } from './lib/types';
import { incMetric } from './lib/metrics';
import { beforeCall as breakerBefore, afterCall as breakerAfter } from './lib/circuit_breaker';
export const EMAIL_RETRY_MAX = 3;

export interface EmailSendResult {
  ok: boolean;
  id?: string;
  error?: string;
  provider?: string;
  provider_error_code?: string;
  internal_code?: string; // normalized internal taxonomy
}

// Re-exported wrapper (kept name inc to minimize diff if referenced elsewhere)
const inc = incMetric;

export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<EmailSendResult> {
  const provider = (env as any).EMAIL_PROVIDER || (env.RESEND_API_KEY ? 'resend' : 'none');
  if (provider === 'none') {
    await inc(env, 'email.no_provider');
    return { ok: true, provider: 'none' };
  }
  if (provider === 'resend') {
    if (!env.RESEND_API_KEY) {
      await inc(env, 'email.no_provider');
      return { ok: true, provider: 'none' };
    }
    // Feature flag: only send real network email when EMAIL_REAL_SEND === '1' and key not 'test'.
    const realMode = env.EMAIL_REAL_SEND === '1' && env.RESEND_API_KEY !== 'test';
    // Test shortcut preserves prior behavior.
    if (env.RESEND_API_KEY === 'test') {
      await inc(env, 'email.sent'); await inc(env, 'email.sent.sim');
      return { ok: true, id: `test-${crypto.randomUUID()}`, provider: 'resend' };
    }
    // Simulation mode (no outbound network) for safety unless explicitly enabled.
    if (!realMode) {
      if (/fail/i.test(to)) { await inc(env, 'email.send_error'); await inc(env,'email.send_error.sim'); return { ok:false, error:'Simulated failure', provider_error_code:'sim_fail', provider:'resend' }; }
      if (/bounce/i.test(to)) {
        await inc(env, 'email.bounce'); await inc(env,'email.bounce.sim');
        // Normalized event metric parity with webhook ingestion path
        await inc(env, 'email.event.bounce');
        return { ok:false, error:'Simulated bounce', provider_error_code:'bounce', provider:'resend' };
      }
      // Simulated success path
      await inc(env,'email.sent'); await inc(env,'email.sent.sim');
      return { ok:true, id:`sim-${crypto.randomUUID()}`, provider:'resend' };
    }
    // Real network dispatch with circuit breaker (keyed by provider host)
    const breakerKey = 'email:resend';
    const gate = breakerBefore(breakerKey);
    if (!gate.allow) { await inc(env, 'email.breaker.blocked'); return { ok:false, error:'circuit_open', provider:'resend', provider_error_code:'circuit_open', internal_code:'circuit_open' }; }
    if (/fail/i.test(to)) { // allow forced failure in real mode for testing
      await inc(env, 'email.send_error'); await inc(env,'email.send_error.real');
  breakerAfter(breakerKey, false, undefined, env);
      return { ok:false, error:'Forced failure (pattern)', provider_error_code:'forced_fail', internal_code:'forced_fail', provider:'resend' };
    }
    let ok=true;
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'alerts@pokequant.io', to:[to], subject, html })
      });
      let provider_error_code: string | undefined; if (!resp.ok) {
        ok=false;
        let text:any; try { text = await resp.json(); } catch { try { text = await resp.text(); } catch { text=''; } }
        if (text && typeof text === 'object') provider_error_code = (text.error && (text.error.code || text.error.type)) || undefined;
        await inc(env, 'email.send_error'); await inc(env,'email.send_error.real');
        const internal = mapProviderError(provider_error_code, resp.status);
        if (internal) { const safe = internal.replace(/[^a-z0-9_]/gi,'_'); await inc(env, `email.error_code.${safe}`); }
        if (provider_error_code) { const pSafe = provider_error_code.toLowerCase().replace(/[^a-z0-9_]/g,'_'); await inc(env, `email.provider_error.${pSafe}`); }
  breakerAfter(breakerKey, false, undefined, env);
        return { ok:false, error:`resend_status_${resp.status}`, provider:'resend', provider_error_code, internal_code: internal };
      }
      const data:any = await resp.json().catch(()=>({}));
	await inc(env, 'email.sent'); await inc(env,'email.sent.real');
  breakerAfter(breakerKey, true, undefined, env);
      return { ok:true, id:data?.id, provider:'resend', provider_error_code };
    } catch (e:any) {
      ok=false;
      await inc(env, 'email.send_error'); await inc(env,'email.send_error.real'); await inc(env,'email.error_code.exception'); await inc(env,'email.provider_error.exception');
  breakerAfter(breakerKey, false, undefined, env);
      return { ok:false, error:String(e), provider:'resend', provider_error_code:'exception', internal_code:'exception' };
    }
  }
  if (provider === 'postmark') {
    // Placeholder implementation; will flesh out after provider decision.
    if (!(env as any).POSTMARK_TOKEN) { await inc(env,'email.no_provider'); return { ok:true, provider:'postmark' }; }
    await inc(env,'email.sent'); await inc(env,'email.sent.sim');
    return { ok:true, id:`pm-${crypto.randomUUID()}`, provider:'postmark' };
  }
  await inc(env,'email.no_provider');
  return { ok:true, provider:'unknown' };
}

// Map provider-specific error codes + HTTP status to normalized internal taxonomy
export function mapProviderError(code: string | undefined, status?: number): string | undefined {
  if (!code && !status) return undefined;
  const c = (code||'').toLowerCase();
  if (c.includes('rate')) return 'email_provider_rate_limited';
  if (c.includes('invalid') || c.includes('recipient')) return 'email_invalid_recipient';
  if (c.includes('policy')) return 'email_policy_block';
  if (c.includes('timeout')) return 'email_provider_timeout';
  if (status) {
    if (status === 429) return 'email_provider_rate_limited';
    if (status >=500) return 'email_provider_error';
    if (status === 400) return 'email_bad_request';
    if (status === 401 || status === 403) return 'email_auth_failure';
  }
  return undefined;
}
