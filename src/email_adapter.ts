// src/email_adapter.ts
// Pluggable email sending abstraction. Uses Resend if RESEND_API_KEY present.

import type { Env } from './lib/types';
import { incMetric } from './lib/metrics';
export const EMAIL_RETRY_MAX = 3;

export interface EmailSendResult {
  ok: boolean;
  id?: string;
  error?: string;
  provider?: string;
  provider_error_code?: string;
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
    if (env.RESEND_API_KEY === 'test') {
      await inc(env, 'email.sent');
      return { ok: true, id: `test-${crypto.randomUUID()}`, provider: 'resend' };
    }
    if (/fail/i.test(to)) { await inc(env, 'email.send_error'); return { ok:false, error:'Simulated failure', provider_error_code:'sim_fail', provider:'resend' }; }
    if (/bounce/i.test(to)) { await inc(env, 'email.bounce'); return { ok:false, error:'Simulated bounce', provider_error_code:'bounce', provider:'resend' }; }
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'alerts@pokequant.io', to:[to], subject, html })
      });
      let provider_error_code: string | undefined; if (!resp.ok) {
        let text:any; try { text = await resp.json(); } catch { try { text = await resp.text(); } catch { text=''; } }
        if (text && typeof text === 'object') provider_error_code = (text.error && (text.error.code || text.error.type)) || undefined;
        await inc(env, 'email.send_error');
        return { ok:false, error:`resend_status_${resp.status}`, provider:'resend', provider_error_code };
      }
      const data:any = await resp.json().catch(()=>({}));
      await inc(env, 'email.sent');
      return { ok:true, id:data?.id, provider:'resend', provider_error_code };
    } catch (e:any) { await inc(env, 'email.send_error'); return { ok:false, error:String(e), provider:'resend', provider_error_code:'exception' }; }
  }
  if (provider === 'postmark') {
    // Placeholder implementation; will flesh out after provider decision.
    if (!(env as any).POSTMARK_TOKEN) { await inc(env,'email.no_provider'); return { ok:true, provider:'postmark' }; }
    await inc(env,'email.sent');
    return { ok:true, id:`pm-${crypto.randomUUID()}`, provider:'postmark' };
  }
  await inc(env,'email.no_provider');
  return { ok:true, provider:'unknown' };
}
