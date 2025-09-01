import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Recompute outbound webhook signature canonically to ensure docs stay accurate.
// Canonical string: `${ts}.${nonce}.${sha256Hex(body)}` where body is exact JSON payload text.

async function sha256Hex(data: string) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return Array.from(new Uint8Array(buf)).map(b=> b.toString(16).padStart(2,'0')).join('');
}

describe('Outbound webhook signature verification', () => {
  it('matches recomputed signature from stored delivery row', async () => {
    const create = await SELF.fetch('https://example.com/admin/webhooks', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ url:'https://example.com/hook-v2', secret:'sekret456' }) });
    expect(create.status).toBe(200);
    const today = new Date().toISOString().slice(0,10);
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'card_SIG2', name:'CardSIG2', set_name:'Set', rarity:'Rare' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:'card_SIG2', as_of: today, price_usd:1, price_eur:1 }] }) });
    const alertRes = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:'sig2@test.com', card_id:'card_SIG2', threshold:5 }) });
    expect(alertRes.status).toBe(200);
    await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    const deliveries = await SELF.fetch('https://example.com/admin/webhooks/deliveries', { headers:{ 'x-admin-token':'test-admin' } });
    const body:any = await deliveries.json();
    const row = body.rows.find((r:any)=> r.signature && r.sig_ts && r.nonce);
    expect(row).toBeTruthy();
    const payload = JSON.parse(row.payload); // ensure valid JSON
    const payloadText = JSON.stringify(payload); // canonical JSON matches generation path
    const bodyHash = await sha256Hex(payloadText);
    const canonical = `${row.sig_ts}.${row.nonce}.${bodyHash}`;
    // Recompute HMAC
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode('sekret456'), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(canonical));
    const recomputed = Array.from(new Uint8Array(sigBuf)).map(b=> b.toString(16).padStart(2,'0')).join('');
    expect(recomputed).toBe(row.signature);
  });
});
