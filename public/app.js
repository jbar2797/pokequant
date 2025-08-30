// Front-end application module (refactored from inline script)
const WORKER_BASE = 'https://pokequant.jonathanbarreneche.workers.dev';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

// ---------- Toast + Status Handling ----------
function toast(msg, kind='info', opts={}) {
  const host = $('#toastHost');
  if(!host) return;
  const div = document.createElement('div');
  div.className = `pointer-events-auto select-none text-xs rounded-md px-3 py-2 shadow border flex items-start gap-2 backdrop-blur bg-slate-900/80 border-slate-700 text-slate-200 dark ${kind==='error'?'bg-red-600/20 border-red-500 text-red-200':kind==='success'?'bg-emerald-600/20 border-emerald-500 text-emerald-200':kind==='warn'?'bg-amber-600/20 border-amber-500 text-amber-200':'bg-slate-800/70'} light:${kind==='error'?'bg-red-50 border-red-200 text-red-700':kind==='success'?'bg-emerald-50 border-emerald-200 text-emerald-700':kind==='warn'?'bg-amber-50 border-amber-200 text-amber-800':'bg-slate-100 border-slate-200 text-slate-800'}`;
  div.innerHTML = `<span class="flex-1 leading-4">${msg}</span>`;
  host.appendChild(div);
  setTimeout(()=> { div.classList.add('opacity-0','translate-y-1','transition'); setTimeout(()=> div.remove(), 400); }, opts.ttl||3500);
}
function setStatus(msg, kind='info'){ // preserve existing banner API for backwards compatibility
  const el=$('#status');
  if(!msg){el.classList.add('hidden');el.textContent='';return;}
  el.textContent=msg; el.classList.remove('hidden');
  const base='mx-4 mt-4 p-2 border rounded text-sm ';
  el.className= base + (kind==='error'?'bg-red-500/10 text-red-300 border-red-500/40 light:text-red-700 light:bg-red-50 light:border-red-200':kind==='success'?'bg-emerald-500/10 text-emerald-300 border-emerald-500/40 light:text-emerald-700 light:bg-emerald-50 light:border-emerald-200':'bg-amber-500/10 text-amber-300 border-amber-500/40 light:text-amber-800 light:bg-amber-50 light:border-amber-300');
  toast(msg, kind);
  setTimeout(()=>setStatus(''),4000);
}

// ---------- Utils ----------
function fmtUSD(x){ return (x==null||isNaN(Number(x)))?'—':'$'+Number(x).toFixed(2); }
function miniBadge(signal){ const s=(signal||'—').toUpperCase(); const arrow = s==='BUY'?'▲':(s==='SELL'?'▼':''); const baseClasses='px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide'; if(s==='BUY') return `<button class="${baseClasses} bg-emerald-600/90 hover:bg-emerald-500 text-white">${arrow} BUY</button>`; if(s==='SELL') return `<button class="${baseClasses} bg-red-600/90 hover:bg-red-500 text-white">${arrow} SELL</button>`; return `<button class="${baseClasses} bg-slate-600/80 hover:bg-slate-500 text-white">HOLD</button>`; }

// ---------- Theme ----------
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
let dark = localStorage.getItem('pq_dark') ? localStorage.getItem('pq_dark') === '1' : prefersDark;
function applyTheme(){
  if(dark){
    document.documentElement.classList.add('dark');
    document.body.classList.remove('light');
  } else {
    document.documentElement.classList.remove('dark');
    document.body.classList.add('light');
  }
  // Update any theme toggle labels (support legacy #themeToggle & new .theme-toggle)
  const icon = dark ? '🌙' : '☀️';
  $('#themeToggle') && ($('#themeToggle').textContent = icon);
  $$('.theme-toggle').forEach(b=> b.textContent = icon + (b.classList.contains('px-3')? '':'') );
}
function toggleTheme(){ dark=!dark; localStorage.setItem('pq_dark', dark?'1':'0'); applyTheme(); }
$('#themeToggle')?.addEventListener('click', toggleTheme);
$$('.theme-toggle').forEach(btn=> btn.addEventListener('click', toggleTheme));
applyTheme();

// ---------- Navigation ----------
function switchView(view){
  $$('.nav-link').forEach(b=> b.classList.toggle('nav-active', b.getAttribute('data-view')===view));
  $$('section[data-panel]').forEach(p=> { if(p.getAttribute('data-panel')===view) p.classList.remove('hidden'); else p.classList.add('hidden'); });
  // lazy triggers
  if(view==='analytics'){ loadFactorPerformance(); loadIcSummary(); loadFactorCorrelations(); }
  if(view==='portfolio'){ loadPortfolio(); loadExposureTrend(); }
  if(view==='admin'){ refreshAdmin(); }
}
$$('.nav-link').forEach(btn=> btn.addEventListener('click',()=> switchView(btn.getAttribute('data-view'))));

// ---------- Fetch helper with timing + error surface ----------
async function fetchJSON(u, opts){
  const started = performance.now();
  const r = await fetch(u, { headers:{ 'accept':'application/json', ...(opts&&opts.headers||{}) }, ...opts });
  let j=null; try { j = await r.json(); } catch { /* ignore */ }
  if(!r.ok){ const msg = (j&&j.error)||`HTTP ${r.status}`; toast(msg,'error'); throw new Error(msg); }
  const ms = performance.now()-started;
  if(ms>1500) toast(`Slow (${Math.round(ms)}ms): ${u.split('?')[0].slice(-32)}`,'warn',{ttl:2500});
  return j;
}

// ---------- Movers ----------
async function loadMovers(){ ensureMoverHosts(); const moversEl=$('#movers'); const losersEl=$('#losers'); if(moversEl) moversEl.innerHTML = skeletonTiles(); if(losersEl) losersEl.innerHTML=skeletonTiles();
  try { const [up,down] = await Promise.all([
    fetchJSON(WORKER_BASE+'/api/movers?n=12'), fetchJSON(WORKER_BASE+'/api/movers?dir=down&n=12')]);
    if(moversEl) moversEl.innerHTML = up.map(tile).join('');
    if(losersEl) losersEl.innerHTML = down.map(tile).join('');
    $('#moversTs') && ($('#moversTs').textContent = new Date().toLocaleTimeString());
  } catch(e){ setStatus('Failed movers','error'); }
}
function abbreviateSet(name){ if(!name) return ''; return name.split(/\s+/).map(w=> w[0]).join('').slice(0,4).toUpperCase(); }
function tile(c){ const price = (c.price_usd!=null)?fmtUSD(c.price_usd):(c.price_eur!=null?'€'+Number(c.price_eur).toFixed(2):'—'); const setAbbr = abbreviateSet(c.set_name); const number = c.number || ''; const img = c.image_url || 'https://placehold.co/160x223?text=Card'; return `<div class="card-tiny text-xs space-y-2 bg-slate-800/40 border border-slate-600/40 hover:border-slate-500 transition-colors">
  <div class="flex gap-3 items-start">
    <div class="w-12 h-16 bg-slate-700/40 rounded overflow-hidden flex items-center justify-center"><img src="${img}" alt="${c.name}" class="max-h-16" loading="lazy"/></div>
    <div class="flex-1 min-w-0">
      <div class="font-medium leading-4 truncate" title="${c.name}">${c.name}</div>
      <div class="text-[10px] text-slate-400">${setAbbr}${number? ' • #'+number:''}</div>
    </div>
  </div>
  <div class="flex items-center justify-between">
    <span class="font-mono text-[11px] text-slate-300">${price}</span>
    <span>${miniBadge(c.signal)}</span>
  </div>
</div>`; }
function skeletonTiles(n=8){ return Array.from({length:n}).map(()=>`<div class="card-tiny animate-pulse h-[110px] bg-slate-800/40 light:bg-slate-200"></div>`).join(''); }
$('#reloadMovers')?.addEventListener('click', loadMovers);

// Ensure movers containers exist after layout refactor & robust fallback
function ensureMoverHosts(){ if(!document.getElementById('movers')){ const el=document.createElement('div'); el.id='movers'; } if(!document.getElementById('losers')){ const el2=document.createElement('div'); el2.id='losers'; } }

// ---------- Cards Explorer ----------
let UNIVERSE = [];
function unique(arr){ return Array.from(new Set(arr)); }
function buildSetOptions(){ const sets = unique(UNIVERSE.map(c=>c.set_name).filter(Boolean)).sort(); const sel=$('#set'); if(!sel) return; sel.innerHTML = '<option value="">All sets</option>' + sets.map(s=>`<option>${s}</option>`).join(''); }
function renderCards(data){ const tb=$('#rows'); if(!tb) return; if(!data.length){ tb.innerHTML='<tr><td class="p-3 text-center text-xs text-slate-400" colspan="8">No cards</td></tr>'; return; } tb.innerHTML=data.map(c=>{ const price=(c.price_usd!=null)?fmtUSD(c.price_usd):(c.price_eur!=null?'€'+Number(c.price_eur).toFixed(2):'—'); const sig=(c.signal||'—').toUpperCase(); const setAb = abbreviateSet(c.set_name); const img = c.image_url || 'https://placehold.co/160x223?text=Card'; return `<tr class="hover-row">
  <td class="p-2"><div class="flex gap-2 items-center"><div class=\"w-10 h-14 rounded bg-slate-700/40 overflow-hidden flex items-center justify-center\"><img src=\"${img}\" class=\"max-h-14\" loading=\"lazy\"/></div><div class="leading-4"><div class="font-medium truncate max-w-[140px]" title="${c.name}">${c.name}</div><div class="text-[10px] text-slate-400">${setAb}${c.number? ' • #'+c.number:''}</div></div></div></td>
  <td class="p-2 text-xs">${c.set_name||''}</td>
  <td class="p-2 text-xs">${c.rarity||''}</td>
  <td class="p-2 text-xs font-mono">${price}</td>
  <td class="p-2">${miniBadge(sig)}</td>
  <td class="p-2 text-xs">${c.score!=null?Number(c.score).toFixed(1):'—'}</td>
  <td class="p-2 text-xs"><button class="underline" data-alert="${c.id}">Alert</button></td>
  <td class="p-2 text-[10px] text-slate-500 font-mono">${c.id}</td>
</tr>`; }).join(''); tb.querySelectorAll('button[data-alert]').forEach(b=> b.addEventListener('click',()=> { $('#alertCardQuick').value = b.getAttribute('data-alert'); switchView('overview'); toast('Card ID prefilled','success'); })); }
function filterCards(){ const q=$('#q')?.value.toLowerCase()||''; const set=$('#set')?.value||''; const rarity=$('#rarity')?.value.toLowerCase()||''; let list=UNIVERSE; if(q) list=list.filter(c=> [c.name,c.set_name,c.id].some(v=> (v||'').toLowerCase().includes(q))); if(set) list=list.filter(c=> c.set_name===set); if(rarity) list=list.filter(c=> (c.rarity||'').toLowerCase()===rarity); FILTERED=list; CARDS_PAGE=1; applyCardsPagination(); }
async function loadUniverse(){ setStatus('Loading cards…'); try { let data = await fetchJSON(WORKER_BASE+'/api/cards'); if(!data.length) data = await fetchJSON(WORKER_BASE+'/api/universe');
  // Normalize to ensure number field exists (backend may omit currently)
  UNIVERSE = data.map(c=> ({ ...c, number: c.number || c.card_number || '' }));
  buildSetOptions(); filterCards(); setStatus('Cards loaded','success'); } catch(e){ setStatus('Cards load failed','error'); } }
['q','set','rarity'].forEach(id=> $('#'+id)?.addEventListener('input', filterCards)); $('#btnReload')?.addEventListener('click', loadUniverse);
$('#cardsPageSize')?.addEventListener('change',()=> { CARDS_PAGE_SIZE = Number($('#cardsPageSize').value)||50; CARDS_PAGE=1; applyCardsPagination(); });

// ---------- Subscribe ----------
$('#sub')?.addEventListener('submit', async e=> { e.preventDefault(); const email=$('#email').value.trim(); if(!email) return; try { await fetchJSON(WORKER_BASE+'/api/subscribe',{ method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({email}) }); setStatus('Subscribed','success'); $('#email').value=''; } catch(e2){ setStatus('Subscription failed','error'); } });

// ---------- Quick Alert ----------
$('#alertCreateQuick')?.addEventListener('click', async()=> { const email=$('#alertEmailQuick').value.trim(); const card=$('#alertCardQuick').value.trim(); const kind=$('#alertKindQuick').value; const threshold=Number($('#alertThrQuick').value); const snooze=Number($('#alertSnoozeQuick').value); if(!email||!card||!Number.isFinite(threshold)) return setStatus('Fill alert fields','error'); try { const body={ email, card_id:card, kind, threshold }; if(Number.isFinite(snooze)) body.snooze_minutes=snooze; const r= await fetchJSON(WORKER_BASE+'/alerts/create',{ method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }); setStatus('Alert created','success'); const meta = $('#alertCreateMeta'); meta.classList.remove('hidden'); meta.innerHTML = `id: <span class="font-mono">${r.id}</span><br/>suppress until: ${r.suppressed_until||'—'} | fired_count: ${r.fired_count}`; } catch(e){ setStatus('Alert create failed','error'); } });

// ---------- Metrics Mini ----------
async function loadMiniMetrics(){ try { const j = await fetchJSON(WORKER_BASE+'/admin/metrics',{ headers: admHeaders() }); const pick = (j.rows||[]).slice(0,6); $('#metricsMini').innerHTML = pick.map(r=> `<li>${r.metric}: <span class="text-emerald-300 light:text-emerald-700">${r.count}</span></li>`).join(''); } catch{} }

// ---------- Portfolio ----------
function pfHeaders(){ const id=$('#pfId')?.value.trim(); const sec=$('#pfSecret')?.value.trim(); return id&&sec? { 'x-portfolio-id':id, 'x-portfolio-secret':sec } : {}; }
$('#pfCreate')?.addEventListener('click', async()=>{ try { const r = await fetchJSON(WORKER_BASE+'/portfolio/create',{ method:'POST' }); $('#pfId').value=r.id; $('#pfSecret').value=r.secret; setStatus('Portfolio created','success'); loadPortfolio(); } catch(e){ setStatus('Create portfolio failed','error'); } });
$('#pfLoad')?.addEventListener('click', loadPortfolio);
$('#pfRotate')?.addEventListener('click', async()=>{ try { const r= await fetchJSON(WORKER_BASE+'/portfolio/rotate-secret',{ method:'POST', headers: pfHeaders() }); $('#pfSecret').value=r.secret; setStatus('Secret rotated','success'); } catch(e){ setStatus('Rotate failed','error'); } });
async function loadPortfolio(){ if(!$('#pfId')?.value||!$('#pfSecret')?.value) return; try { const r= await fetchJSON(WORKER_BASE+'/portfolio',{ headers: pfHeaders() }); const rows = r.rows||[]; const tb=$('#pfLots'); if(!tb) return; if(!rows.length) $('#pfLotsEmpty').classList.remove('hidden'); else $('#pfLotsEmpty').classList.add('hidden'); tb.innerHTML = rows.map(l=> `<tr class="border-b border-slate-800/40 light:border-slate-200"><td class="p-1">${l.card_id}</td><td class="p-1 text-right">${l.qty}</td><td class="p-1 text-right">${fmtUSD(l.cost_usd)}</td><td class="p-1 text-right">${l.price_usd?fmtUSD(l.price_usd):'—'}</td><td class="p-1 text-center"><button class="underline text-[10px]" data-del="${l.lot_id}">Del</button></td></tr>`).join(''); tb.querySelectorAll('button[data-del]').forEach(b=> b.addEventListener('click',()=> deleteLot(b.getAttribute('data-del')))); $('#pfTotals').textContent = `MV: ${fmtUSD(r.totals.market_value)} | Cost: ${fmtUSD(r.totals.cost_basis)} | Unrealized: ${fmtUSD(r.totals.unrealized)}`; loadPnl(); } catch(e){ setStatus('Load portfolio failed','error'); } }
async function deleteLot(id){ if(!id) return; try { await fetchJSON(WORKER_BASE+'/portfolio/delete-lot',{ method:'POST', headers:{ 'content-type':'application/json', ...pfHeaders() }, body: JSON.stringify({ lot_id:id }) }); setStatus('Lot deleted','success'); loadPortfolio(); } catch(e){ setStatus('Delete failed','error'); } }
$('#pfAddLotBtn')?.addEventListener('click',()=> $('#lotModal').classList.remove('hidden'));
$('#lotModalClose')?.addEventListener('click',()=> $('#lotModal').classList.add('hidden'));
$('#lotAdd')?.addEventListener('click', async()=> { const card=$('#lotCard').value.trim(); const qty=Number($('#lotQty').value); const cost=Number($('#lotCost').value); if(!card||!Number.isFinite(qty)||!Number.isFinite(cost)) return setStatus('Fill lot fields','error'); try { await fetchJSON(WORKER_BASE+'/portfolio/add-lot',{ method:'POST', headers:{'content-type':'application/json', ...pfHeaders()}, body: JSON.stringify({ card_id:card, qty, cost_usd:cost }) }); setStatus('Lot added','success'); $('#lotModal').classList.add('hidden'); loadPortfolio(); } catch(e){ setStatus('Add lot failed','error'); } });
async function loadTargets(){ try { const r = await fetchJSON(WORKER_BASE+'/portfolio/targets',{ headers: pfHeaders() }); $('#pfTargets').textContent = JSON.stringify(r.rows||[], null, 0); } catch(e){ setStatus('Load targets failed','error'); } }
async function createOrder(){ try { await fetchJSON(WORKER_BASE+'/portfolio/orders',{ method:'POST', headers: pfHeaders(), body: JSON.stringify({}) }); setStatus('Order created','success'); listOrders(); } catch(e){ setStatus('Create order failed','error'); } }
async function listOrders(){ try { const r= await fetchJSON(WORKER_BASE+'/portfolio/orders',{ headers: pfHeaders() }); const rows=r.rows||[]; $('#pfOrders').innerHTML = rows.map(o=> `<div><button class="underline" data-order="${o.id}">${o.id.slice(0,8)}</button> • ${o.status} • ${o.objective}</div>`).join(''); $('#pfOrders').querySelectorAll('button[data-order]').forEach(b=> b.addEventListener('click',()=> orderDetail(b.getAttribute('data-order')))); } catch(e){ setStatus('List orders failed','error'); } }
async function orderDetail(id){ try { const r= await fetchJSON(WORKER_BASE+'/portfolio/orders/detail?id='+encodeURIComponent(id),{ headers: pfHeaders() }); $('#pfOrderDetail').textContent = JSON.stringify(r,null,2); } catch(e){ setStatus('Order detail failed','error'); } }
let pnlSparkChart;
async function loadPnl(){ try { const r= await fetchJSON(WORKER_BASE+'/portfolio/pnl',{ headers: pfHeaders() }); const rows=(r.rows||[]).slice(-30); $('#pfPnl')?.textContent = JSON.stringify(rows,null,0); // sparkline
  const ctx=$('#pnlSpark'); if(ctx){ const labels=rows.map(x=> x.as_of || '').slice(-30); const data=rows.map(x=> x.market_value || 0); if(pnlSparkChart) pnlSparkChart.destroy(); pnlSparkChart = new Chart(ctx,{ type:'line', data:{ labels, datasets:[{ label:'MV', data, tension:0.3, borderColor:'#6366f1', borderWidth:1, pointRadius:0, fill: { target:'origin', above:'rgba(99,102,241,0.15)' } }]}, options:{ responsive:true, plugins:{ legend:{ display:false }}, scales:{ x:{ display:false }, y:{ display:false }}, elements:{ line:{ borderJoinStyle:'round' }}}}); }
} catch{} }

// ---------- Analytics ----------
let factorChart; async function loadFactorPerformance(){ try { const perf = await fetchJSON(WORKER_BASE+'/admin/factor-performance',{ headers: admHeaders() }); const factors=(perf.factors||[]).slice(0,10); const ctx=$('#factorChart'); const labels=factors.map(f=> f.factor); const data=factors.map(f=> f.ret_30d||0); if(factorChart) factorChart.destroy(); factorChart=new Chart(ctx,{ type:'bar', data:{ labels, datasets:[{ label:'30d Return', data, backgroundColor: data.map(v=> v>0?'rgba(16,185,129,0.6)':'rgba(239,68,68,0.6)') }]}, options:{ scales:{ y:{ ticks:{ callback: v=> (v*100).toFixed(1)+'%' } }}}}); $('#factorChartLegend').textContent='Showing top 10 factors by presence; green positive.'; } catch(e){ $('#factorChartLegend').textContent='Factor performance unavailable (admin token required).'; } }
async function loadIcSummary(){ try { const ic = await fetchJSON(WORKER_BASE+'/admin/factor-ic/summary',{ headers: admHeaders() }); const rows=(ic.rows||[]).slice(0,9); $('#icSummary').innerHTML = rows.map(r=> `<div class="p-3 rounded bg-slate-800/40 light:bg-slate-100 border border-slate-700/40 light:border-slate-200"><div class="font-semibold text-xs mb-1">${r.factor}</div><div class="text-[10px] space-y-0.5 leading-3"><div>IC30d: ${(r.ic_avg_30d??0).toFixed(3)}</div><div>Hit: ${(r.ic_hit_30d??0).toFixed(2)}</div><div>IR: ${(r.ic_ir_30d??0).toFixed(2)}</div></div></div>`).join(''); } catch(e){ $('#icSummary').textContent='IC summary unavailable.'; } }

// ---------- Admin ----------
let ADMIN_TOKEN = localStorage.getItem('pq_admin_token')||''; if(ADMIN_TOKEN) $('#admToken').value=ADMIN_TOKEN; function admHeaders(){ return ADMIN_TOKEN? { 'x-admin-token': ADMIN_TOKEN }: {}; }
$('#admSet')?.addEventListener('click',()=>{ ADMIN_TOKEN=$('#admToken').value.trim(); localStorage.setItem('pq_admin_token', ADMIN_TOKEN); setStatus('Admin token set','success'); refreshAdmin(); });
$('#admRefreshAlerts')?.addEventListener('click', refreshAdmin);
$('#admRunDue')?.addEventListener('click', async()=> { try { const j = await fetchJSON(WORKER_BASE+'/admin/ingestion-schedule/run-due?run=1',{ method:'POST', headers: { 'content-type':'application/json', ...admHeaders() }, body: '{}' }); $('#admRunDueResult').textContent = JSON.stringify(j,null,1); setStatus('Run-due executed','success'); } catch(e){ setStatus('Run-due failed','error'); } });
async function refreshAdmin(){ loadMiniMetrics(); try { const stats = await fetchJSON(WORKER_BASE+'/admin/alerts/stats',{ headers: admHeaders() }); $('#admAlertStats').textContent = JSON.stringify(stats,null,1); const list = await fetchJSON(WORKER_BASE+'/admin/alerts',{ headers: admHeaders() }); $('#admAlertsList').innerHTML = '<table class="w-full"><thead class="sticky top-0 bg-slate-900 text-[10px]"><tr><th class="p-1 text-left">ID</th><th class="p-1">Email</th><th class="p-1">Card</th><th class="p-1">Kind</th><th class="p-1">Fired</th><th class="p-1">Supp</th></tr></thead><tbody>'+ (list.rows||[]).slice(0,100).map(a=> `<tr class="border-b border-slate-800/40"><td class="p-1 text-[10px] font-mono">${a.id.slice(0,8)}</td><td class="p-1 text-[10px]">${a.email}</td><td class="p-1 text-[10px]">${a.card_id}</td><td class="p-1 text-[10px]">${a.kind}</td><td class="p-1 text-[10px]">${a.fired_count||0}</td><td class="p-1 text-[10px]">${a.suppressed_until?'Y':'N'}</td></tr>`).join('') +'</tbody></table>'; } catch(e){ $('#admAlertStats').textContent='Admin endpoints require valid token.'; }
  try { const m = await fetchJSON(WORKER_BASE+'/admin/metrics',{ headers: admHeaders() }); $('#admMetrics').textContent = JSON.stringify(m.rows.slice(0,20),null,1); } catch(e){ /* ignore */ }
}

// ---------- Polling (lightweight) ----------
let moversInterval = setInterval(loadMovers, 60_000);

// ---------- Initial Loads (guarded) ----------
async function initialLoad(){
  try { loadMovers(); } catch(e){ console.error(e); }
  try { loadUniverse(); } catch(e){ console.error(e); }
  try { loadMiniMetrics(); } catch(e){ console.error(e); }
  try { loadFactorPerformance(); loadIcSummary(); loadFactorCorrelations(); } catch(e){ console.error(e); }
  try { refreshAdmin(); } catch(e){ console.error(e); }
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialLoad); else initialLoad();

// Global error surface
window.addEventListener('error', ev=> { toast('UI error: '+ (ev.message||'unknown'),'error',{ ttl:5000 }); });
window.addEventListener('unhandledrejection', ev=> { toast('Promise error','error'); });

// Enhance: global search bridges to cards view filtering
const globalSearchEl = document.getElementById('globalSearch');
if(globalSearchEl){
  globalSearchEl.addEventListener('input', () => {
    // Switch to cards view if not already
    switchView('cards');
    const qBox = document.getElementById('q');
    if(qBox){ qBox.value = globalSearchEl.value; filterCards(); }
  });
}
// Mobile menu toggles sidebar clone (simple)
const mobileMenuBtn = document.getElementById('mobileMenu');
if(mobileMenuBtn){
  mobileMenuBtn.addEventListener('click', () => {
    let panel = document.getElementById('mobileNavPanel');
    if(!panel){
      panel = document.createElement('div');
      panel.id = 'mobileNavPanel';
      panel.className = 'fixed inset-0 z-50 bg-slate-900/80 backdrop-blur flex';
      panel.innerHTML = `<div class="w-60 bg-slate-950 border-r border-slate-800 p-4 flex flex-col gap-2">${Array.from(document.querySelectorAll('aside nav button.nav-link')).map(b=>`<button data-mobile-view="${b.getAttribute('data-view')}" class="text-left px-3 py-2 rounded hover:bg-slate-800 text-sm">${b.textContent}</button>`).join('')}<button id="closeMobileNav" class="mt-auto text-xs underline">Close</button></div>`;
      document.body.appendChild(panel);
      panel.addEventListener('click', e=> { if(e.target.id==='closeMobileNav') panel.remove(); });
      panel.querySelectorAll('[data-mobile-view]').forEach(btn=> btn.addEventListener('click', () => { switchView(btn.getAttribute('data-mobile-view')); panel.remove(); }));
    } else {
      panel.remove();
    }
  });
}

// Expose minimal debugging hooks
window.PQ = { reload: { movers: loadMovers, cards: loadUniverse, portfolio: loadPortfolio, analytics: ()=>{loadFactorPerformance();loadIcSummary();}, admin: refreshAdmin } };
