// New application entry (v0.7.2)
import { VERSION, fetchJSON, PLACEHOLDER, signalBadge, fmtUSD, abbreviateSet } from './core.js';
import { loadMovers, wireMoversClicks } from './movers.js';
import { toast, setStatus } from './toast.js';
import './theme.js';
import './health.js';

const rootVersionEl = document.getElementById('appVersion');
if(rootVersionEl) rootVersionEl.textContent = VERSION;

// Simple state
const state = { cards: [], view: 'overview', filtered: [] };

// Navigation
function switchView(v){
  state.view = v;
  document.querySelectorAll('[data-view]').forEach(el=> el.classList.toggle('active', el.dataset.view===v));
  document.querySelectorAll('[data-panel]').forEach(p=> { p.hidden = p.dataset.panel !== v; });
  if(v==='cards' && !state.cards.length) loadCards();
}

document.addEventListener('click', e=> {
  const navBtn = e.target.closest('[data-view]');
  if(navBtn){ switchView(navBtn.dataset.view); }
});

// Cards load
async function loadCards(){
  const host = document.getElementById('cardsTableBody');
  if(host) host.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try {
    let data = await fetchJSON('/api/cards');
    if(!data.length) data = await fetchJSON('/api/universe');
    state.cards = data.map(c=> ({ ...c, number: c.number || c.card_number || '' }));
    state.filtered = state.cards;
    renderCards();
    setStatus('Cards loaded','success');
  } catch(e){ if(host) host.innerHTML = '<tr><td colspan="6">Error loading cards</td></tr>'; setStatus('Cards load failed','error'); }
}

function renderCards(){
  const host = document.getElementById('cardsTableBody');
  if(!host) return;
  const list = state.filtered;
  if(!list.length){ host.innerHTML = '<tr><td colspan="6">No data</td></tr>'; return; }
  host.innerHTML = list.slice(0,200).map(c=> row(c)).join('');
}
function row(c){
  const price = (c.price_usd!=null)?fmtUSD(c.price_usd):(c.price_eur!=null?'€'+Number(c.price_eur).toFixed(2):'—');
  const setAb = abbreviateSet(c.set_name);
  const img = c.image_url || PLACEHOLDER;
  return `<tr data-card-id="${c.id}">
    <td><div style="display:flex;gap:6px;align-items:center"><div style="width:40px;height:54px;background:#1e293b;border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center"><img src="${img}" alt="" loading="lazy" onerror="this.src='${PLACEHOLDER}'" style="max-height:54px"/></div><div style="min-width:0"><div style="font-size:12px;font-weight:600;line-height:1.2" title="${c.name}">${c.name}</div><div style="font-size:10px;opacity:.6">${setAb}${c.number? ' · #'+c.number:''}</div></div></div></td>
    <td style="font-size:11px">${c.set_name||''}</td>
    <td style="font-size:11px">${c.rarity||''}</td>
    <td style="font-size:11px" class="mono">${price}</td>
    <td style="font-size:11px">${signalBadge(c.signal)}</td>
    <td style="font-size:10px;opacity:.6" class="mono">${c.id}</td>
  </tr>`;
}


// --- Card Side Panel (lightweight detail) ---
const sidePanel = document.getElementById('cardSidePanel');
const sidePanelBody = document.getElementById('cardPanelBody');
document.getElementById('cardPanelClose')?.addEventListener('click', ()=> closeSidePanel());
function openSidePanel(){ if(sidePanel){ sidePanel.style.width='420px'; } }
function closeSidePanel(){ if(sidePanel){ sidePanel.style.width='0'; sidePanelBody.innerHTML=''; } }
async function showCard(id){
  try {
    openSidePanel();
    sidePanelBody.innerHTML = '<div style="padding:40px;text-align:center">Loading…</div>';
    const j = await fetchJSON(`/api/card?id=${encodeURIComponent(id)}&days=90`);
    const c = j.card || { id };
    const img = c.image_url || PLACEHOLDER;
    sidePanelBody.innerHTML = `<div style="display:flex;gap:16px;align-items:flex-start">
      <div style="width:110px;height:160px;background:#1e293b;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center"><img src="${img}" alt="${c.name||id}" style="max-height:150px" onerror="this.src='${PLACEHOLDER}'"/></div>
      <div style="flex:1;min-width:0">
        <h4 style="margin:0 0 4px;font-size:16px;font-weight:600;letter-spacing:.3px">${c.name||id}</h4>
        <div style="font-size:11px;opacity:.7;margin-bottom:10px">${c.set_name||''}${c.number? ' · #'+c.number:''}</div>
        <div id="cardMetaInline" style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px"></div>
      </div>
    </div>`;
  } catch(e){ sidePanelBody.innerHTML='<div style="padding:40px;text-align:center;color:#f87171">Failed to load card</div>'; }
}

document.addEventListener('click', e=> {
  const tile = e.target.closest('.tile[data-card-id]');
  if(tile) showCard(tile.dataset.cardId);
  const row = e.target.closest('tr[data-card-id]');
  if(row) showCard(row.dataset.cardId);
});

// Simple client-side filter bound to globalSearch
loadMovers().catch(()=> setStatus('Movers load failed','error'));

// --- Quick Alert Creation ---
const alertForm = document.getElementById('alertQuickForm');
if(alertForm){
  alertForm.addEventListener('submit', async e=> {
    e.preventDefault();
    const form = new FormData(alertForm);
    const body = {
      email: form.get('email')?.toString().trim(),
      card_id: form.get('card_id')?.toString().trim(),
      kind: form.get('kind'),
      threshold: Number(form.get('threshold'))
    };
    const snooze = form.get('snooze');
    if(snooze) body.snooze_minutes = Number(snooze);
    if(!body.email||!body.card_id||!Number.isFinite(body.threshold)) return setStatus('Fill required alert fields','error');
    try {
      const r = await fetchJSON('/alerts/create',{ method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
      setStatus('Alert created','success');
      const res = document.getElementById('alertQuickResult');
      if(res) res.innerHTML = `id: <span style="font-family:monospace">${r.id}</span> • fired: ${r.fired_count||0}`;
    } catch(e2){ setStatus('Alert create failed','error'); }
  });
}

// --- Portfolio Summary (read-only) ---
const portfolioLoadBtn = document.getElementById('portfolioLoadBtn');
if(portfolioLoadBtn){
  portfolioLoadBtn.addEventListener('click', async ()=> {
    const pid = document.querySelector('#portfolioAuth input[name=pid]')?.value.trim();
    const psec = document.querySelector('#portfolioAuth input[name=psec]')?.value.trim();
    if(!pid||!psec) return setStatus('Portfolio creds required','error');
    const headers = { 'x-portfolio-id': pid, 'x-portfolio-secret': psec };
    try {
      const r = await fetchJSON('/portfolio',{ headers });
      const lots = r.rows || [];
      const summaryEl = document.getElementById('portfolioSummary');
      if(summaryEl) summaryEl.innerHTML = `<strong>${lots.length}</strong> lots • MV ${fmtUSD(r.totals?.market_value)} • Unrealized ${fmtUSD(r.totals?.unrealized)}`;
      const lotsHost = document.getElementById('portfolioLotsMini');
      if(lotsHost){
        if(!lots.length) lotsHost.innerHTML = '<div style="opacity:.6">No lots</div>';
        else lotsHost.innerHTML = lots.slice(0,12).map(l=> `<div style="border:1px solid #253349;padding:6px 8px;border-radius:8px;background:#162132"><div style="font-size:11px;font-weight:600">${l.card_id}</div><div style="font-size:10px;opacity:.65">Qty ${l.qty}</div></div>`).join('');
      }
      setStatus('Portfolio loaded','success');
    } catch(e){ setStatus('Portfolio load failed','error'); }
  });
}

// --- Admin Metrics Mini ---
let ADMIN_TOKEN = '';
const adminSetBtn = document.getElementById('adminTokenSet');
if(adminSetBtn){
  adminSetBtn.addEventListener('click', async ()=> {
    ADMIN_TOKEN = document.getElementById('adminTokenInput')?.value.trim();
    await loadAdminMetrics();
  });
}
async function loadAdminMetrics(){
  try {
    const rows = await fetchJSON('/admin/metrics',{ headers: ADMIN_TOKEN? { 'x-admin-token': ADMIN_TOKEN }: {} });
    const list = document.getElementById('adminMetricsList');
    if(list){ list.innerHTML = (rows.rows||[]).slice(0,12).map(r=> `<li style="border:1px solid #253349;padding:6px 8px;border-radius:8px;background:#162132"><span style="font-size:10px;opacity:.7">${r.metric}</span><br/><strong style="font-size:12px">${r.count}</strong></li>`).join(''); }
  } catch(e){ const list = document.getElementById('adminMetricsList'); if(list) list.innerHTML = '<li style="opacity:.6">Metrics unavailable</li>'; }
}

if(globalSearch){
  globalSearch.addEventListener('input', ()=> {
    const q = globalSearch.value.toLowerCase();
    if(!q) state.filtered = state.cards; else state.filtered = state.cards.filter(c=> [c.name,c.set_name,c.id].some(v=> (v||'').toLowerCase().includes(q)) );
    renderCards();
  });
}

// Card modal removed (temporary) to resolve persistent rectangle issue.
function openCard(id){ /* modal disabled */ }

// Movers wiring
wireMoversClicks(openCard);
loadMovers().catch(()=> setStatus('Movers load failed','error'));

// Expose basic debug
window.PQv2 = { state, reloadMovers: loadMovers, loadCards, openCard };

console.log('%cPokeQuant v'+VERSION,'background:#6366f1;color:#fff;padding:2px 6px;border-radius:4px');
