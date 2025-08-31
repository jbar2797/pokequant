import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

// Additional public route coverage to exercise branches in public.ts

async function seedBasicCard() {
  const today = new Date().toISOString().slice(0,10);
  await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'card_pub', name:'PubCard', set_name:'SetA', rarity:'Rare', image_url:'u', types:'Type', number:'001' }] }) });
  await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:'card_pub', as_of: today, price_usd:10, price_eur:9 }] }) });
  await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'signals_daily', rows:[{ card_id:'card_pub', as_of: today, signal:'buy', score: 1.23, edge_z: 0.5, exp_ret:0.1, exp_sd:0.2 }] }) });
  await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'svi_daily', rows:[{ card_id:'card_pub', as_of: today, svi: 5 }] }) });
  await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'signal_components_daily', rows:[{ card_id:'card_pub', as_of: today, ts7:1, ts30:2, dd:0.1, vol:0.2, z_svi: 0.3 }] }) });
}

describe('Public routes additional coverage', () => {
  it('cards list endpoint returns list with caching headers & 304 logic', async () => {
    await seedBasicCard();
    const r1 = await SELF.fetch('https://example.com/api/cards');
    expect(r1.status).toBe(200);
    const etag = r1.headers.get('ETag');
    expect(etag).toBeTruthy();
    const r2 = await SELF.fetch('https://example.com/api/cards', { headers:{ 'If-None-Match': etag! } });
    expect(r2.status).toBe(304);
  });

  it('movers endpoint respects dir=down and n param', async () => {
    await seedBasicCard();
    const r = await SELF.fetch('https://example.com/api/movers?dir=down&n=5');
    expect(r.status).toBe(200);
    const data:any = await r.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('card detail endpoint errors on missing id', async () => {
    const r = await SELF.fetch('https://example.com/api/card');
    expect(r.status).toBe(400);
  });

  it('card detail returns structured object and research CSV exports headers', async () => {
    await seedBasicCard();
    const today = new Date().toISOString().slice(0,10);
    const detail = await SELF.fetch(`https://example.com/api/card?id=card_pub&days=5`); // days <7 coerced
    expect(detail.status).toBe(200);
    const dj:any = await detail.json();
    expect(dj.ok).toBe(true);
    expect(dj.card?.id).toBe('card_pub');
    const csv = await (await SELF.fetch(`https://example.com/research/card-csv?id=card_pub&days=30`)).text();
    expect(csv.split('\n')[0]).toBe('d,usd,eur,svi,signal,score,edge_z,exp_ret,exp_sd,ts7,ts30,dd,vol,z_svi');
    // Should contain the seeded date
    expect(csv).toContain(today);
  });
});
