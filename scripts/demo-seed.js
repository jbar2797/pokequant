#!/usr/bin/env node
// Populate a small deterministic demo dataset (cards, prices, signals, components, watchlist)
// Usage: npm run demo:seed -- [BASE_URL] [ADMIN_TOKEN]
// Defaults: BASE_URL=http://127.0.0.1:8787 ADMIN_TOKEN=test-admin

const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8787';
const ADMIN = process.argv[3] || process.env.ADMIN_TOKEN || 'test-admin';

async function post(path, body) {
  const r = await fetch(BASE + path, { method:'POST', headers:{ 'x-admin-token':ADMIN, 'content-type':'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { console.error('POST failed', path, r.status); const t = await r.text(); console.error(t); }
  return r;
}

async function seed() {
  const today = new Date().toISOString().slice(0,10);
  const cards = [
    { id:'demo_charizard', name:'Charizard Holo', set_name:'Base', rarity:'Rare', image_url:'', types:'Fire|Flying', number:'004' },
    { id:'demo_pikachu', name:'Pikachu', set_name:'Jungle', rarity:'Common', image_url:'', types:'Electric', number:'025' },
    { id:'demo_blastoise', name:'Blastoise', set_name:'Base', rarity:'Rare', image_url:'', types:'Water', number:'009' }
  ];
  for (const c of cards) {
    await post('/admin/test-insert', { table:'cards', rows:[c] });
    const price = 10 + Math.random()*50;
    await post('/admin/test-insert', { table:'prices_daily', rows:[{ card_id:c.id, as_of: today, price_usd: Number(price.toFixed(2)) }] });
    const score = Math.random()*8 + 1;
    await post('/admin/test-insert', { table:'signals_daily', rows:[{ card_id:c.id, as_of: today, score, signal: score > 5 ? 'BUY':'HOLD', edge_z:(score-5)/2, exp_ret:0.01*score, exp_sd:0.05 }] });
    await post('/admin/test-insert', { table:'signal_components_daily', rows:[{ card_id:c.id, as_of: today, ts7:Math.random(), ts30:Math.random(), dd: -Math.random()*0.2, vol: Math.random()*0.5, z_svi: (Math.random()*2-1) }] });
  }
  // Add first two to watchlist
  for (const id of ['demo_charizard','demo_pikachu']) {
    await fetch(BASE + '/api/watchlist', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ id }) });
  }
  console.log('Demo seed complete. Try endpoints:');
  console.log('-', BASE + '/api/dashboard');
  console.log('-', BASE + '/api/watchlist');
  console.log('-', BASE + '/api/cards');
}

seed().catch(e=> { console.error(e); process.exit(1); });