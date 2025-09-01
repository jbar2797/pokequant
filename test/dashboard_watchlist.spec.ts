import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

async function seed(id: string) {
  const today = new Date().toISOString().slice(0,10);
  await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id, name:`Name-${id}`, set_name:'SetW', rarity:'Rare', image_url:'u', types:'Type', number:'001' }] }) });
  await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:id, as_of: today, price_usd:10 }] }) });
  await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'signals_daily', rows:[{ card_id:id, as_of: today, signal:'BUY', score: 5, edge_z:1, exp_ret:0.02, exp_sd:0.05 }] }) });
}

describe('Dashboard & watchlist', () => {
  it('dashboard endpoint returns ok structure', async () => {
    await seed('dash1');
    const r = await SELF.fetch('https://example.com/api/dashboard');
    expect(r.status).toBe(200);
    const j:any = await r.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.top)).toBe(true);
    expect(j.counts).toBeTruthy();
  });

  it('watchlist add/list/delete cycle works', async () => {
    await seed('watch1');
    // Add
    const add = await SELF.fetch('https://example.com/api/watchlist', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ id:'watch1' }) });
    expect(add.status).toBe(200);
    const list1 = await SELF.fetch('https://example.com/api/watchlist');
    const j1:any = await list1.json();
    expect(j1.ok).toBe(true);
    expect(j1.items.find((r:any)=> r.id==='watch1')).toBeTruthy();
    const del = await SELF.fetch('https://example.com/api/watchlist?id=watch1', { method:'DELETE' });
    expect(del.status).toBe(200);
    const list2 = await SELF.fetch('https://example.com/api/watchlist');
    const j2:any = await list2.json();
    expect(j2.items.find((r:any)=> r.id==='watch1')).toBeFalsy();
  });
});
