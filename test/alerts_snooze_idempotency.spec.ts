import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

async function create() {
  const body = { email:'snooze-idem@example.com', card_id:'CARD-1', kind:'price_below', threshold: 5 };
  const r = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  return await r.json() as any;
}

describe('Alerts snooze idempotency', () => {
  it('replays identical snooze and conflicts on change', async () => {
    const a = await create();
    const key = 'idem-snooze-1';
    const token = a.manage_token;
    const id = a.id;
    const minutes = 15;
    const snoozeBody = JSON.stringify({ token, minutes });
    const h = { 'content-type':'application/json', 'idempotency-key': key } as any;
    // first
    const r1 = await SELF.fetch(`https://example.com/alerts/snooze?id=${id}`, { method:'POST', headers: h, body: snoozeBody });
    expect(r1.status).toBe(200);
    const j1:any = await r1.json();
    expect(j1.suppressed_for_minutes).toBe(minutes);
    // replay
    const r2 = await SELF.fetch(`https://example.com/alerts/snooze?id=${id}`, { method:'POST', headers: h, body: snoozeBody });
    expect(r2.status).toBe(200);
    const j2:any = await r2.json();
    expect(j2.suppressed_for_minutes).toBe(minutes);
    // conflict with different minutes
    const r3 = await SELF.fetch(`https://example.com/alerts/snooze?id=${id}`, { method:'POST', headers: h, body: JSON.stringify({ token, minutes: minutes+5 }) });
    expect(r3.status).toBe(409);
  });
});
