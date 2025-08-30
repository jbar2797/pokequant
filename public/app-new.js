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

// Simple client-side filter bound to globalSearch
const globalSearch = document.getElementById('globalSearch');
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
