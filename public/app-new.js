// New application entry (v0.7.2)
import { VERSION, fetchJSON, PLACEHOLDER, signalBadge, fmtUSD, abbreviateSet } from './core.js';
import { loadMovers, wireMoversClicks } from './movers.js';
import { toast, setStatus } from './toast.js';
import './theme.js';
import './health.js';

const rootVersionEl = document.getElementById('appVersion');
if(rootVersionEl) rootVersionEl.textContent = VERSION;

// Screen reader live region helper (wrap status updates)
const __sr = document.getElementById('srLive');
const __origSetStatus = setStatus;
// announce: mirror status to visual banner + screen reader live region
function announce(msg, kind){
  __origSetStatus(msg, kind);
  if(__sr) __sr.textContent = msg || '';
}

// Simple state
const state = { cards: [], view: 'overview', filtered: [], page:1, pageSize:50 };

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
  announce('Cards loaded','success');
  } catch(e){ if(host) host.innerHTML = '<tr><td colspan="6">Error loading cards</td></tr>'; announce('Cards load failed','error'); }
}

function renderCards(){
  const host = document.getElementById('cardsTableBody');
  if(!host) return;
  const list = state.filtered;
  if(!list.length){ host.innerHTML = '<tr><td colspan="6">No data</td></tr>'; return; }
  const start = (state.page-1)*state.pageSize;
  const slice = list.slice(start, start+state.pageSize);
  host.innerHTML = slice.map(c=> row(c)).join('');
  renderPager();
}
function renderPager(){
  const pager = document.getElementById('cardsPager');
  if(!pager) return;
  const total = state.filtered.length;
  const pages = Math.max(1, Math.ceil(total/state.pageSize));
  if(state.page>pages) state.page=pages;
  pager.innerHTML = `
    <button data-page="prev" ${state.page===1?'disabled':''} style="padding:4px 8px;background:#162132;color:#e5ecf5;border:1px solid #253349;border-radius:6px;cursor:pointer;${state.page===1?'opacity:.4;cursor:not-allowed':''}">Prev</button>
    <span>Page <strong>${state.page}</strong> / ${pages} • ${total} rows</span>
    <button data-page="next" ${state.page===pages?'disabled':''} style="padding:4px 8px;background:#162132;color:#e5ecf5;border:1px solid #253349;border-radius:6px;cursor:pointer;${state.page===pages?'opacity:.4;cursor:not-allowed':''}">Next</button>
    <label style="margin-left:auto;display:flex;align-items:center;gap:4px">Page Size
      <select id="cardsPageSize" style="background:#162132;border:1px solid #253349;color:#e5ecf5;padding:4px 6px;border-radius:6px">
        ${[25,50,100,200].map(n=> `<option ${n===state.pageSize?'selected':''}>${n}</option>`).join('')}
      </select>
    </label>`;
  pager.querySelector('[data-page="prev"]').onclick = ()=> { if(state.page>1){ state.page--; renderCards(); } };
  pager.querySelector('[data-page="next"]').onclick = ()=> { const pages2=Math.ceil(state.filtered.length/state.pageSize); if(state.page<pages2){ state.page++; renderCards(); } };
  pager.querySelector('#cardsPageSize').onchange = (e)=> { state.pageSize=Number(e.target.value)||50; state.page=1; renderCards(); };
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
let lastFocused = null;
function openSidePanel(){ if(sidePanel){ sidePanel.style.width='420px'; } }
function closeSidePanel(){ if(sidePanel){ sidePanel.style.width='0'; sidePanelBody.innerHTML=''; if(lastFocused && typeof lastFocused.focus==='function') setTimeout(()=> lastFocused.focus(),30); } }
document.getElementById('cardPanelClose')?.addEventListener('click', closeSidePanel);
async function showCard(id){
  try {
    lastFocused = document.activeElement;
    openSidePanel();
    sidePanelBody.innerHTML = '<div style="padding:40px;text-align:center">Loading…</div>';
    const j = await fetchJSON(`/api/card?id=${encodeURIComponent(id)}&days=90`);
    const c = j.card || { id };
    const img = c.image_url || PLACEHOLDER;
    // price sparkline
    const prices = j.prices || [];
    const priceSpark = prices.slice(-40).map(p=> p.usd ?? p.eur ?? null).filter(v=> v!=null);
    let sparkHtml = '';
    if(priceSpark.length){
      const min = Math.min(...priceSpark), max=Math.max(...priceSpark) || 1;
      const points = priceSpark.map((v,i)=> {
        const x = (i/(priceSpark.length-1))*100; const y = 100 - ((v-min)/(max-min||1))*100; return `${x.toFixed(2)},${y.toFixed(2)}`; }).join(' ');
      const last = priceSpark[priceSpark.length-1];
      sparkHtml = `<div style="margin-top:4px"><svg viewBox='0 0 100 100' preserveAspectRatio='none' style='width:100%;height:40px;background:#0f172a;border-radius:4px'><polyline fill='none' stroke='${last>=priceSpark[0]?'#10b981':'#ef4444'}' stroke-width='2' points='${points}'/></svg><div style='font-size:10px;opacity:.6;margin-top:2px'>${last.toFixed(2)} ${last>=priceSpark[0]? '▲':'▼'}</div></div>`;
    }
    sidePanelBody.innerHTML = `<div style="display:flex;gap:16px;align-items:flex-start">
      <div style="width:110px;height:160px;background:#1e293b;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center"><img src="${img}" alt="${c.name||id}" style="max-height:150px" onerror="this.src='${PLACEHOLDER}'"/></div>
      <div style="flex:1;min-width:0">
        <h4 style="margin:0 0 4px;font-size:16px;font-weight:600;letter-spacing:.3px">${c.name||id}</h4>
        <div style="font-size:11px;opacity:.7;margin-bottom:10px">${c.set_name||''}${c.number? ' · #'+c.number:''}</div>
        <div id="cardMetaInline" style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px"></div>
        <div style="margin-top:14px">${sparkHtml||'<span style="font-size:10px;opacity:.5">No recent prices</span>'}</div>
      </div>
    </div>`;
  } catch(e){ sidePanelBody.innerHTML='<div style="padding:40px;text-align:center;color:#f87171">Failed to load card</div>'; }
}

// --- Quick Alert Form ---
const alertQuickForm = document.getElementById('alertQuickForm');
if(alertQuickForm){
  alertQuickForm.addEventListener('submit', async (ev)=> {
    ev.preventDefault();
    const form = new FormData(alertQuickForm);
    const body = {
      email: form.get('email')?.toString().trim(),
      card_id: form.get('card_id')?.toString().trim(),
      kind: form.get('kind'),
      threshold: Number(form.get('threshold'))
    };
    const snooze = form.get('snooze');
    if(snooze) body.snooze_minutes = Number(snooze);
  if(!body.email||!body.card_id||!Number.isFinite(body.threshold)) return announce('Fill required alert fields','error');
    try {
      const r = await fetchJSON('/alerts/create',{ method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(body) });
  announce('Alert created','success');
      const res = document.getElementById('alertQuickResult');
      if(res) res.innerHTML = `id: <span style="font-family:monospace">${r.id}</span> • fired: ${r.fired_count||0}`;
  } catch(e2){ announce('Alert create failed','error'); }
  });
}

// --- Portfolio Summary (read-only) ---
const portfolioLoadBtn = document.getElementById('portfolioLoadBtn');
const portfolioRefreshBtn = document.getElementById('portfolioRefreshBtn');
const portfolioRotateSecretBtn = document.getElementById('portfolioRotateSecretBtn');
const portfolioCrudSection = document.getElementById('portfolioCrudSection');
const portfolioLotsBody = document.getElementById('portfolioLotsBody');
const portfolioLotsEmpty = document.getElementById('portfolioLotsEmpty');
const portfolioAddLotForm = document.getElementById('portfolioAddLotForm');
let currentPortfolioAuth = null; // { id, secret }

function getPortfolioAuth(){
  const pid = document.querySelector('#portfolioAuth input[name=pid]')?.value.trim();
  const psec = document.querySelector('#portfolioAuth input[name=psec]')?.value.trim();
  if(!pid||!psec) return null;
  return { id: pid, secret: psec };
}

async function loadPortfolio(showToast=true){
  const auth = getPortfolioAuth();
  if(!auth){ if(showToast) announce('Portfolio creds required','error'); return; }
  currentPortfolioAuth = auth;
  const headers = { 'x-portfolio-id': auth.id, 'x-portfolio-secret': auth.secret };
  try {
    const r = await fetchJSON('/portfolio',{ headers });
    renderPortfolio(r);
    if(showToast) announce('Portfolio loaded','success');
  } catch(e){ if(showToast) announce('Portfolio load failed','error'); }
}

function renderPortfolio(r){
  const lots = r.rows || [];
  const summaryEl = document.getElementById('portfolioSummary');
  if(summaryEl) summaryEl.innerHTML = `<strong>${lots.length}</strong> lots • MV ${fmtUSD(r.totals?.market_value)} • Unrealized ${fmtUSD(r.totals?.unrealized)}`;
  const lotsMini = document.getElementById('portfolioLotsMini');
  if(lotsMini){
    if(!lots.length) lotsMini.innerHTML = '<div style="opacity:.6">No lots</div>';
    else lotsMini.innerHTML = lots.slice(0,12).map(l=> `<div style="border:1px solid #253349;padding:6px 8px;border-radius:8px;background:#162132"><div style="font-size:11px;font-weight:600">${l.card_id}</div><div style="font-size:10px;opacity:.65">Qty ${l.qty}</div></div>`).join('');
  }
  if(portfolioCrudSection) portfolioCrudSection.style.display = 'flex';
  if(portfolioLotsBody){
    if(!lots.length){
      portfolioLotsBody.innerHTML='';
      if(portfolioLotsEmpty) portfolioLotsEmpty.style.display='block';
    } else {
      if(portfolioLotsEmpty) portfolioLotsEmpty.style.display='none';
      portfolioLotsBody.innerHTML = lots.map(l=> portfolioLotRow(l)).join('');
      wireLotRowActions();
    }
  }
}

function portfolioLotRow(l){
  const mv = l.price_usd!=null && l.qty!=null? l.price_usd * l.qty : null;
  const unrl = (mv!=null && l.cost_usd!=null)? mv - l.cost_usd : null;
  return `<tr data-lot-id="${l.lot_id}">
    <td style="padding:4px 6px;font-family:monospace;font-size:10px">${l.card_id}</td>
    <td style="padding:4px 6px"><input type="number" step="1" value="${l.qty}" data-field="qty" style="width:70px;background:#162132;border:1px solid #253349;color:#e5ecf5;padding:3px 4px;border-radius:4px;font-size:11px" /></td>
    <td style="padding:4px 6px"><input type="number" step="0.01" value="${l.cost_usd??''}" data-field="cost_usd" style="width:90px;background:#162132;border:1px solid #253349;color:#e5ecf5;padding:3px 4px;border-radius:4px;font-size:11px" /></td>
    <td style="padding:4px 6px;font-size:11px">${mv!=null? fmtUSD(mv):'—'}</td>
    <td style="padding:4px 6px;font-size:11px">${unrl!=null? fmtUSD(unrl):'—'}</td>
    <td style="padding:4px 6px;font-size:11px;display:flex;gap:4px;flex-wrap:wrap">
      <button data-action="save" style="background:#2563eb;border:1px solid #2563eb;color:#fff;font-size:10px;padding:4px 8px;border-radius:5px;cursor:pointer">Save</button>
      <button data-action="delete" style="background:#b91c1c;border:1px solid #b91c1c;color:#fff;font-size:10px;padding:4px 8px;border-radius:5px;cursor:pointer">Del</button>
    </td>
  </tr>`;
}

function wireLotRowActions(){
  portfolioLotsBody?.querySelectorAll('tr').forEach(tr=> {
    tr.querySelectorAll('button[data-action]').forEach(btn=> {
      btn.addEventListener('click', async ()=> {
        const lotId = tr.getAttribute('data-lot-id');
        const action = btn.getAttribute('data-action');
        if(action==='delete'){
          await deleteLot(lotId);
        } else if(action==='save'){
          const qty = parseFloat(tr.querySelector('input[data-field="qty"]').value);
          const cost = parseFloat(tr.querySelector('input[data-field="cost_usd"]').value);
          await updateLot(lotId, { qty: Number.isFinite(qty)? qty: undefined, cost_usd: Number.isFinite(cost)? cost: undefined });
        }
      });
    });
  });
}

async function addLot(body){
  if(!currentPortfolioAuth) return announce('Load portfolio first','error');
  try {
    const headers = { 'content-type':'application/json', 'x-portfolio-id': currentPortfolioAuth.id, 'x-portfolio-secret': currentPortfolioAuth.secret };
    await fetchJSON('/portfolio/add-lot',{ method:'POST', headers, body: JSON.stringify(body) });
    announce('Lot added','success');
    await loadPortfolio(false);
  } catch(e){ announce('Add lot failed','error'); }
}
async function updateLot(lot_id, changes){
  if(!currentPortfolioAuth) return announce('Load portfolio first','error');
  try {
    const headers = { 'content-type':'application/json', 'x-portfolio-id': currentPortfolioAuth.id, 'x-portfolio-secret': currentPortfolioAuth.secret };
    await fetchJSON('/portfolio/update-lot',{ method:'POST', headers, body: JSON.stringify({ lot_id, ...changes }) });
    announce('Lot updated','success');
    await loadPortfolio(false);
  } catch(e){ announce('Update failed','error'); }
}
async function deleteLot(lot_id){
  if(!currentPortfolioAuth) return announce('Load portfolio first','error');
  if(!confirm('Delete this lot?')) return;
  try {
    const headers = { 'content-type':'application/json', 'x-portfolio-id': currentPortfolioAuth.id, 'x-portfolio-secret': currentPortfolioAuth.secret };
    await fetchJSON('/portfolio/delete-lot',{ method:'POST', headers, body: JSON.stringify({ lot_id }) });
    announce('Lot deleted','success');
    await loadPortfolio(false);
  } catch(e){ announce('Delete failed','error'); }
}
async function rotateSecret(){
  if(!currentPortfolioAuth) return announce('Load portfolio first','error');
  if(!confirm('Rotate secret? Old secret becomes invalid immediately.')) return;
  try {
    const headers = { 'x-portfolio-id': currentPortfolioAuth.id, 'x-portfolio-secret': currentPortfolioAuth.secret };
    const r = await fetchJSON('/portfolio/rotate-secret',{ method:'POST', headers });
    announce('Secret rotated','success');
    // Update UI inputs
    document.querySelector('#portfolioAuth input[name=psec]').value = r.secret;
    currentPortfolioAuth.secret = r.secret;
  } catch(e){ announce('Rotate failed','error'); }
}

if(portfolioLoadBtn){
  portfolioLoadBtn.addEventListener('click', ()=> loadPortfolio(true));
}
if(portfolioRefreshBtn){
  portfolioRefreshBtn.addEventListener('click', ()=> loadPortfolio(true));
}
if(portfolioRotateSecretBtn){
  portfolioRotateSecretBtn.addEventListener('click', rotateSecret);
}
if(portfolioAddLotForm){
  portfolioAddLotForm.addEventListener('submit', ev=> {
    ev.preventDefault();
    const fd = new FormData(portfolioAddLotForm);
    const card_id = fd.get('card_id')?.toString().trim();
    const qty = Number(fd.get('qty'));
    const cost_usd = Number(fd.get('cost_usd'));
    const acquired_at = fd.get('acquired_at')?.toString().trim();
    if(!card_id || !Number.isFinite(qty) || !Number.isFinite(cost_usd)) return announce('Lot form invalid','error');
    addLot({ card_id, qty, cost_usd, acquired_at: acquired_at||undefined });
    portfolioAddLotForm.reset();
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
  } catch(e){ const list = document.getElementById('adminMetricsList'); if(list) list.innerHTML = '<li style="opacity:.6">Metrics unavailable</li>'; announce('Admin metrics unavailable','error'); }
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
loadMovers().catch(()=> announce('Movers load failed','error'));

// Expose basic debug
window.PQv2 = { state, reloadMovers: loadMovers, loadCards, openCard, loadPortfolio, addLot, updateLot, deleteLot };

console.log('%cPokeQuant v'+VERSION,'background:#6366f1;color:#fff;padding:2px 6px;border-radius:4px');
