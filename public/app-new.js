// New application entry (v0.7.4)
import { VERSION, fetchJSON, PLACEHOLDER, signalBadge, fmtUSD, abbreviateSet } from './core.js';
import { loadMovers, wireMoversClicks } from './movers.js';

const rootVersionEl = document.getElementById('appVersion');
if(rootVersionEl) rootVersionEl.textContent = VERSION;

// Simple state
const state = { cards: [], view: 'overview' };

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
    renderCards();
  } catch(e){ if(host) host.innerHTML = '<tr><td colspan="6">Error loading cards</td></tr>'; }
}

function renderCards(){
  const host = document.getElementById('cardsTableBody');
  if(!host) return;
  if(!state.cards.length){ host.innerHTML = '<tr><td colspan="6">No data</td></tr>'; return; }
  host.innerHTML = state.cards.slice(0,200).map(c=> row(c)).join('');
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

// Card modal (minimal for now + close handlers)
const modal = document.getElementById('cardModalNew');
const modalBody = document.getElementById('cardModalBodyNew');
let lastFocus = null;
function openCard(id){
  if(!modal) return;
  lastFocus = document.activeElement;
  modal.hidden=false;
  modalBody.innerHTML = '<div style="padding:30px;text-align:center">Loading card…</div>';
  loadCardDetail(id);
  // focus close button for accessibility
  setTimeout(()=> {
    const closeBtn = document.getElementById('cardModalCloseNew');
    closeBtn && closeBtn.focus();
  }, 30);
}
function closeModal(){
  if(!modal) return;
  modal.hidden = true;
  if(lastFocus && typeof lastFocus.focus === 'function') setTimeout(()=> lastFocus.focus(), 30);
}
async function loadCardDetail(id){
  try {
    const j = await fetchJSON(`/api/card?id=${encodeURIComponent(id)}&days=90`);
    const c = j.card || { id };
    const img = (c.image_url || PLACEHOLDER);
    modalBody.innerHTML = `<div style="display:flex;gap:24px;align-items:flex-start">
      <div style="width:140px;height:200px;background:#1e293b;border-radius:12px;overflow:hidden;display:flex;align-items:center;justify-content:center"><img src="${img}" alt="${c.name||id}" style="max-height:190px" onerror="this.src='${PLACEHOLDER}'"/></div>
      <div style="flex:1;min-width:0">
        <h3 style="margin:0 0 6px;font-size:20px;font-weight:600;letter-spacing:-.5px">${c.name||id}</h3>
        <div style="font-size:12px;opacity:.7;margin-bottom:12px">${c.set_name||''}${c.number? ' · #'+c.number:''}</div>
        <div style="display:flex;gap:14px;font-size:12px;flex-wrap:wrap" id="cardMetaInline"></div>
      </div>
    </div>`;
  } catch(e){ modalBody.innerHTML = '<div style="padding:40px;text-align:center;color:#f87171">Failed to load card</div>'; }
}

document.addEventListener('click', e=> {
  const tile = e.target.closest('.tile[data-card-id]');
  if(tile) openCard(tile.dataset.cardId);
  const row = e.target.closest('tr[data-card-id]');
  if(row) openCard(row.dataset.cardId);
  if(e.target.id==='cardModalCloseNew'){ closeModal(); }
  if(e.target === modal){ closeModal(); }
});

document.addEventListener('keydown', e=> {
  if(e.key==='Escape' && !modal.hidden){ closeModal(); }
});

// Movers wiring
wireMoversClicks(openCard);
loadMovers();

// Expose basic debug
window.PQv2 = { state, reloadMovers: loadMovers, loadCards, openCard };

console.log('%cPokeQuant v'+VERSION,'background:#6366f1;color:#fff;padding:2px 6px;border-radius:4px');
