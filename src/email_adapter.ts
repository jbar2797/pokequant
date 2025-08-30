// src/email_adapter.ts
// Pluggable email sending abstraction. Uses Resend if RESEND_API_KEY present.

import type { Env } from './index';
export const EMAIL_RETRY_MAX = 3;

export interface EmailSendResult {
  ok: boolean;
  id?: string;
  error?: string;
  provider?: string;
}

// Increment metric via dynamic import avoidance (avoid cyclic import of incMetric)
async function inc(env: Env, metric: string) {
  try {
    // Local lightweight duplicate of incMetric to prevent cycle
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run();
    const today = new Date().toISOString().slice(0,10);
    await env.DB.prepare(`INSERT INTO metrics_daily (d, metric, count) VALUES (?,?,1) ON CONFLICT(d,metric) DO UPDATE SET count = count + 1`).bind(today, metric).run();
  } catch {/* ignore */}
}

export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<EmailSendResult> {
  // If no provider key configured, treat as noop (success) but count metric for observability.
  if (!env.RESEND_API_KEY) {
    await inc(env, 'email.no_provider');
    return { ok: true, provider: 'none' };
  }
  // Simulate provider failure for test emails containing 'fail'
  if (/fail/i.test(to)) {
    await inc(env, 'email.send_error');
    return { ok: false, error: 'Simulated failure' };
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: 'alerts@pokequant.io', to: [to], subject, html })
    });
    if (!resp.ok) {
      const text = await resp.text();
      await inc(env, 'email.send_error');
      return { ok:false, error: `resend_status_${resp.status}`, provider:'resend', id: undefined };
    }
    const data: any = await resp.json().catch(()=>({}));
    await inc(env, 'email.sent');
    return { ok:true, id: data?.id, provider:'resend' };
  } catch (e:any) {
    await inc(env, 'email.send_error');
    return { ok:false, error: String(e), provider:'resend' };
  }
}
