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
const portfolioTargetsSection = document.getElementById('portfolioTargetsSection');
let portfolioTargetsLoaded = false;
let portfolioFactorTargets = {}; // current targets map
let portfolioFactorExposures = {}; // latest exposures
let portfolioOrdersCache = []; // recent orders list
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
  // Load factor targets & exposures lazily after portfolio load
  loadPortfolioTargetsAndExposures();
  loadPortfolioOrders();
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
  if(portfolioTargetsSection) portfolioTargetsSection.style.display='flex';
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

// ---- Factor Targets & Orders ----
async function loadPortfolioTargetsAndExposures(){
  if(!currentPortfolioAuth) return;
  const headers = { 'x-portfolio-id': currentPortfolioAuth.id, 'x-portfolio-secret': currentPortfolioAuth.secret };
  try {
    const t = await fetchJSON('/portfolio/targets',{ headers });
    portfolioFactorTargets = {};
    (t.rows||[]).forEach(r=> { if(r.kind==='factor') portfolioFactorTargets[r.target_key]=r.target_value; });
  } catch(e){ portfolioFactorTargets = {}; }
  try {
    const ex = await fetchJSON('/portfolio/exposure',{ headers });
    portfolioFactorExposures = ex.exposures || {};
  } catch(e){ portfolioFactorExposures = {}; }
  renderTargetsUI();
}

function renderTargetsUI(){
  if(!portfolioTargetsSection) return;
  const hostId = 'portfolioTargetsContent';
  let content = document.getElementById(hostId);
  if(!content){
    content = document.createElement('div');
    content.id = hostId;
    content.style.display='flex';
    content.style.flexDirection='column';
    content.style.gap='12px';
    portfolioTargetsSection.appendChild(content);
  }
  const factors = Array.from(new Set([...Object.keys(portfolioFactorTargets), ...Object.keys(portfolioFactorExposures)])).sort();
  if(!factors.length){ content.innerHTML='<div style="font-size:11px;opacity:.6">No factor data yet.</div>'; return; }
  content.innerHTML = `
    <div style="overflow:auto;border:1px solid #253349;border-radius:10px;max-height:260px">
      <table style="width:100%;border-collapse:collapse;font-size:11px;min-width:500px">
        <thead style="position:sticky;top:0;background:#101726"><tr>
          <th style='text-align:left;padding:6px 8px'>Factor</th>
          <th style='text-align:left;padding:6px 8px'>Exposure</th>
          <th style='text-align:left;padding:6px 8px'>Target</th>
          <th style='text-align:left;padding:6px 8px'>Delta</th>
        </tr></thead>
        <tbody>
          ${factors.map(f=> {
            const ex = portfolioFactorExposures[f];
            const tgt = portfolioFactorTargets[f];
            const delta = (ex!=null && tgt!=null)? (tgt - ex): null;
            return `<tr data-factor='${f}'>
              <td style='padding:4px 6px;font-size:11px;font-weight:600'>${f}</td>
              <td style='padding:4px 6px'>${ex!=null? ex.toFixed(3):'—'}</td>
              <td style='padding:4px 6px'><input type='number' step='0.01' data-target-input value='${tgt!=null? tgt:''}' style='width:80px;background:#162132;border:1px solid #253349;color:#e5ecf5;padding:3px 4px;border-radius:4px;font-size:11px' /></td>
              <td style='padding:4px 6px'>${delta!=null? delta.toFixed(3):'—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style='display:flex;gap:8px;flex-wrap:wrap'>
      <button id='portfolioTargetsSave' style='background:#6366f1;border:1px solid #6366f1;color:#fff;padding:6px 12px;border-radius:8px;font-size:11px;cursor:pointer;font-weight:600'>Save Targets</button>
      <button id='portfolioCreateOrder' style='background:#2563eb;border:1px solid #2563eb;color:#fff;padding:6px 12px;border-radius:8px;font-size:11px;cursor:pointer;font-weight:600'>Create Order</button>
      <button id='portfolioReloadTargets' style='background:#162132;border:1px solid #253349;color:#e5ecf5;padding:6px 12px;border-radius:8px;font-size:11px;cursor:pointer'>Reload</button>
    </div>
    <div id='portfolioOrdersWrap' style='display:flex;flex-direction:column;gap:8px'>
      <h4 style='margin:12px 0 0;font-size:12px;font-weight:600;letter-spacing:.5px'>Recent Orders</h4>
      <div id='portfolioOrdersList' style='font-size:11px;display:flex;flex-direction:column;gap:4px'></div>
      <div id='portfolioOrderDetail' style='font-size:11px;line-height:1.4'></div>
    </div>
  `;
  // Wire buttons
  content.querySelector('#portfolioTargetsSave')?.addEventListener('click', saveTargetsFromUI);
  content.querySelector('#portfolioCreateOrder')?.addEventListener('click', ()=> createPortfolioOrder());
  content.querySelector('#portfolioReloadTargets')?.addEventListener('click', loadPortfolioTargetsAndExposures);
  renderOrdersList();
}

async function saveTargetsFromUI(){
  if(!currentPortfolioAuth) return announce('Load portfolio first','error');
  const map = {};
  portfolioTargetsSection.querySelectorAll('tr[data-factor]').forEach(tr=> {
    const f = tr.getAttribute('data-factor');
    const val = parseFloat(tr.querySelector('input[data-target-input]').value);
    if(Number.isFinite(val)) map[f]=val; // omit empties
  });
  try {
    const headers = { 'content-type':'application/json', 'x-portfolio-id': currentPortfolioAuth.id, 'x-portfolio-secret': currentPortfolioAuth.secret };
    await fetchJSON('/portfolio/targets',{ method:'POST', headers, body: JSON.stringify({ factors: map }) });
    announce('Targets saved','success');
    portfolioFactorTargets = map;
    renderTargetsUI();
  } catch(e){ announce('Save targets failed','error'); }
}

async function createPortfolioOrder(){
  if(!currentPortfolioAuth) return announce('Load portfolio first','error');
  try {
    const headers = { 'content-type':'application/json', 'x-portfolio-id': currentPortfolioAuth.id, 'x-portfolio-secret': currentPortfolioAuth.secret };
    const r = await fetchJSON('/portfolio/orders',{ method:'POST', headers, body: JSON.stringify({ objective: 'align_targets' }) });
    announce('Order created','success');
    await loadPortfolioOrders();
    if(r.id) showOrderDetail(r.id);
  } catch(e){ announce('Create order failed','error'); }
}

async function loadPortfolioOrders(){
  if(!currentPortfolioAuth) return; 
  try {
    const headers = { 'x-portfolio-id': currentPortfolioAuth.id, 'x-portfolio-secret': currentPortfolioAuth.secret };
    const r = await fetchJSON('/portfolio/orders',{ headers });
    portfolioOrdersCache = r.rows || [];
    renderOrdersList();
  } catch(e){ portfolioOrdersCache = []; renderOrdersList(); }
}

function renderOrdersList(){
  const list = document.getElementById('portfolioOrdersList');
  if(!list) return;
  if(!portfolioOrdersCache.length){ list.innerHTML = '<div style="opacity:.6">No orders</div>'; return; }
  list.innerHTML = portfolioOrdersCache.slice(0,8).map(o=> `<div data-order-id='${o.id}' style='border:1px solid #253349;padding:6px 8px;border-radius:6px;background:#162132;display:flex;align-items:center;gap:8px'>
    <span style='font-family:monospace'>${o.id.slice(0,8)}</span>
    <span>${o.status}</span>
    <span style='opacity:.6'>${o.objective||''}</span>
    <button data-order-detail='${o.id}' style='margin-left:auto;background:#2563eb;border:1px solid #2563eb;color:#fff;font-size:10px;padding:4px 8px;border-radius:5px;cursor:pointer'>Detail</button>
  </div>`).join('');
  list.querySelectorAll('button[data-order-detail]').forEach(btn=> btn.addEventListener('click', ()=> showOrderDetail(btn.getAttribute('data-order-detail'))));
}

async function showOrderDetail(id){
  if(!currentPortfolioAuth) return;
  const pane = document.getElementById('portfolioOrderDetail');
  if(pane) pane.innerHTML = '<div style="opacity:.6">Loading order…</div>';
  try {
    const headers = { 'x-portfolio-id': currentPortfolioAuth.id, 'x-portfolio-secret': currentPortfolioAuth.secret };
    const r = await fetchJSON(`/portfolio/orders/detail?id=${encodeURIComponent(id)}`,{ headers });
    if(!pane) return;
    const sugg = r.suggestions || {}; const factorDeltas = sugg.factor_deltas || {}; const trades = (sugg.trades||[]);
    pane.innerHTML = `<div style='border:1px solid #253349;padding:10px 12px;border-radius:8px;background:#101726'>
      <div style='font-size:11px;margin-bottom:6px'><strong>Order</strong> ${r.id} • ${r.status}</div>
      <div style='display:flex;flex-wrap:wrap;gap:8px;font-size:10px;opacity:.85'>${Object.entries(factorDeltas).map(([f,v])=> `<span style='border:1px solid #253349;padding:4px 6px;border-radius:6px;background:#162132'>${f}: ${v>=0?'+':''}${v.toFixed(3)}</span>`).join('')||'<em style="opacity:.5">No factor deltas</em>'}</div>
      <div style='margin-top:8px;font-size:10px;opacity:.7'>Trades: ${trades.length||0}</div>
      <div style='margin-top:8px;display:flex;gap:6px'>
        <button id='portfolioOrderRefresh' style='background:#162132;border:1px solid #253349;color:#e5ecf5;font-size:10px;padding:4px 8px;border-radius:5px;cursor:pointer'>Refresh</button>
        <button id='portfolioOrderExecute' ${r.status==='executed'?'disabled':''} style='background:#16a34a;border:1px solid #16a34a;color:#fff;font-size:10px;padding:4px 8px;border-radius:5px;cursor:pointer;${r.status==='executed'?'opacity:.5;cursor:not-allowed':''}'>Execute</button>
      </div>
    </div>`;
    pane.querySelector('#portfolioOrderRefresh')?.addEventListener('click', ()=> showOrderDetail(id));
    pane.querySelector('#portfolioOrderExecute')?.addEventListener('click', ()=> executePortfolioOrder(id));
  } catch(e){ if(pane) pane.innerHTML = '<div style="color:#f87171">Failed to load order</div>'; }
}

async function executePortfolioOrder(id){
  if(!currentPortfolioAuth) return;
  try {
    const headers = { 'content-type':'application/json', 'x-portfolio-id': currentPortfolioAuth.id, 'x-portfolio-secret': currentPortfolioAuth.secret };
    await fetchJSON('/portfolio/orders/execute',{ method:'POST', headers, body: JSON.stringify({ id }) });
    announce('Order executed','success');
    await loadPortfolioOrders();
    showOrderDetail(id);
  } catch(e){ announce('Execute failed','error'); }
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

// --- Factor Analytics (admin) ---
const factorAnalyticsRefresh = document.getElementById('factorAnalyticsRefresh');
const factorPerformanceHost = document.getElementById('factorPerformanceHost');
const factorCorrelationsHost = document.getElementById('factorCorrelationsHost');
const factorAnalyticsStatus = document.getElementById('factorAnalyticsStatus');

async function loadFactorAnalytics(){
  if(!ADMIN_TOKEN){ announce('Admin token needed','error'); return; }
  if(factorAnalyticsStatus) factorAnalyticsStatus.textContent = 'Loading factor analytics…';
  await Promise.all([loadFactorPerformance(), loadFactorCorrelations()]);
  if(factorAnalyticsStatus) factorAnalyticsStatus.textContent = 'Loaded factor analytics';
  announce('Factor analytics loaded','success');
}

async function loadFactorPerformance(){
  try {
    const r = await fetchJSON('/admin/factor-performance',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    const rows = r.factors||[];
    if(!rows.length){ factorPerformanceHost.innerHTML = '<div style="font-size:11px;opacity:.6;padding:8px">No factor performance rows</div>'; return; }
    factorPerformanceHost.innerHTML = `<table style='width:100%;border-collapse:collapse;font-size:11px;min-width:720px'>
      <thead style='position:sticky;top:0;background:#101726'><tr>
        <th style='text-align:left;padding:6px 8px'>Factor</th>
        <th style='text-align:left;padding:6px 8px'>IC30d</th>
        <th style='text-align:left;padding:6px 8px'>IR30d</th>
        <th style='text-align:left;padding:6px 8px'>Ret30d</th>
        <th style='text-align:left;padding:6px 8px'>Smoothed</th>
        <th style='text-align:left;padding:6px 8px'>Suggest Wt</th>
      </tr></thead><tbody>
      ${rows.map(f=> `<tr>
        <td style='padding:4px 6px;font-weight:600'>${f.factor}</td>
        <td style='padding:4px 6px'>${fmtNum(f.ic_avg_30d)}</td>
        <td style='padding:4px 6px'>${fmtNum(f.ic_ir_30d)}</td>
        <td style='padding:4px 6px'>${fmtNum(f.ret_30d)}</td>
        <td style='padding:4px 6px'>${fmtNum(f.ret_smoothed)}</td>
        <td style='padding:4px 6px'>${f.weight_suggest!=null? (f.weight_suggest*100).toFixed(1)+'%':'—'}</td>
      </tr>`).join('')}
      </tbody></table>`;
  } catch(e){ factorPerformanceHost.innerHTML = '<div style="color:#f87171;font-size:11px;padding:8px">Factor performance failed</div>'; }
}

async function loadFactorCorrelations(){
  try {
    const r = await fetchJSON('/admin/factor-correlations',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    const matrix = r.matrix || r.rows || []; // unsure actual shape; fallback
    // Expect maybe { factors:[], matrix:[[...]] }? We'll attempt to parse
    if(Array.isArray(r.factors) && Array.isArray(r.matrix)){
      const factors = r.factors;
      factorCorrelationsHost.innerHTML = correlationTable(factors, r.matrix);
    } else if(Array.isArray(matrix) && matrix.length && matrix[0].factor_i){
      // pair list; build set
      const factors = Array.from(new Set(matrix.map(p=> p.factor_i).concat(matrix.map(p=> p.factor_j)))).sort();
      // build matrix map corr
      const corrMap = {}; matrix.forEach(p=> { corrMap[p.factor_i+"|"+p.factor_j]=p.corr; corrMap[p.factor_j+"|"+p.factor_i]=p.corr; });
      const table = `<table style='width:100%;border-collapse:collapse;font-size:10px;min-width:720px'>
        <thead style='position:sticky;top:0;background:#101726'><tr><th style='text-align:left;padding:4px 6px'>Factor</th>${factors.map(f=> `<th style='padding:4px 6px'>${f}</th>`).join('')}</tr></thead>
        <tbody>
          ${factors.map(fi=> `<tr><td style='padding:4px 6px;font-weight:600'>${fi}</td>${factors.map(fj=> {
            const v = fi===fj?1:corrMap[fi+'|'+fj];
            const color = v==null? '#334155': (v>0? `rgba(16,185,129,${Math.min(1,Math.abs(v))})`:`rgba(239,68,68,${Math.min(1,Math.abs(v))})`);
            return `<td style='padding:2px 4px;text-align:center;background:${color};color:#fff'>${v!=null? v.toFixed(2):''}</td>`; }).join('')}</tr>`).join('')}
        </tbody></table>`;
      factorCorrelationsHost.innerHTML = table;
    } else {
      factorCorrelationsHost.innerHTML = '<div style="font-size:11px;opacity:.6;padding:8px">No correlation data</div>';
    }
  } catch(e){ factorCorrelationsHost.innerHTML = '<div style="color:#f87171;font-size:11px;padding:8px">Correlations failed</div>'; }
}

function fmtNum(v){ return v==null? '—': Number(v).toFixed(3); }
// --- Factor Weights ---
const factorWeightsRefresh = document.getElementById('factorWeightsRefresh');
const factorWeightsAuto = document.getElementById('factorWeightsAuto');
const factorWeightsHost = document.getElementById('factorWeightsHost');
const factorWeightsStatus = document.getElementById('factorWeightsStatus');
async function loadFactorWeights(){
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  if(factorWeightsStatus) factorWeightsStatus.textContent = 'Loading weights…';
  try {
    const r = await fetchJSON('/admin/factor-weights',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    const rows = r.weights||[];
    if(!rows.length){ factorWeightsHost.innerHTML = '<div style="font-size:11px;opacity:.6;padding:8px">No weights</div>'; }
    else {
      factorWeightsHost.innerHTML = `<table style='width:100%;border-collapse:collapse;font-size:11px;min-width:480px'>
        <thead style='position:sticky;top:0;background:#101726'><tr><th style='text-align:left;padding:6px 8px'>Factor</th><th style='text-align:left;padding:6px 8px'>Weight</th><th style='text-align:left;padding:6px 8px'>Auto</th></tr></thead>
        <tbody>${rows.map(w=> `<tr><td style='padding:4px 6px;font-weight:600'>${w.factor}</td><td style='padding:4px 6px'>${fmtNum(w.weight)}</td><td style='padding:4px 6px'>${w.auto? '✅':'—'}</td></tr>`).join('')}</tbody></table>`;
    }
    if(factorWeightsStatus) factorWeightsStatus.textContent = 'Weights loaded';
    announce('Weights loaded','success');
  } catch(e){ factorWeightsHost.innerHTML = '<div style="color:#f87171;font-size:11px;padding:8px">Weights load failed</div>'; if(factorWeightsStatus) factorWeightsStatus.textContent='Load failed'; announce('Weights load failed','error'); }
}
async function autoFactorWeights(){
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  try { await fetchJSON('/admin/factor-weights/auto',{ method:'POST', headers:{ 'x-admin-token': ADMIN_TOKEN } }); announce('Weights auto derived','success'); loadFactorWeights(); } catch(e){ announce('Auto derive failed','error'); }
}
if(factorWeightsRefresh) factorWeightsRefresh.addEventListener('click', loadFactorWeights);
if(factorWeightsAuto) factorWeightsAuto.addEventListener('click', autoFactorWeights);

// --- Charts (IC & PnL) ---
let factorIcChart, portfolioPnlChart;
function ensureChart(ctx, type, data, options){
  if(!window.Chart) return null;
  if(ctx._chart){ ctx._chart.destroy(); }
  ctx._chart = new Chart(ctx, { type, data, options });
  return ctx._chart;
}
// Build IC chart from factorIcHistoryHost table for selected factor
function rebuildFactorIcChart(){
  const select = document.getElementById('factorIcChartSelect');
  const canvas = document.getElementById('factorIcChart');
  if(!select || !canvas) return;
  const factor = select.value; if(!factor) return;
  // parse table data
  const tbl = factorIcHistoryHost?.querySelector('table tbody');
  if(!tbl){ return; }
  const rows = Array.from(tbl.querySelectorAll('tr'));
  const labels = []; const values=[];
  // Determine column index for factor
  const headerCells = factorIcHistoryHost.querySelectorAll('thead th');
  let colIdx=-1; headerCells.forEach((th,i)=> { if(th.textContent===factor) colIdx=i; });
  if(colIdx===-1) return;
  rows.slice(-90).forEach(r=> { const cells = r.querySelectorAll('td'); const date=cells[0].textContent; const txt=cells[colIdx].textContent; const v=parseFloat(txt); if(date){ labels.push(date); values.push(Number.isFinite(v)?v:null); } });
  ensureChart(canvas.getContext('2d'),'line',{ labels, datasets:[{ label: factor+' IC', data: values, borderColor:'#6366f1', backgroundColor:'rgba(99,102,241,.2)', spanGaps:true, tension:.25 }] }, { responsive:true, scales:{ y:{ beginAtZero:false } }, plugins:{ legend:{ display:false } } });
}
function populateFactorIcChartSelect(){
  const select = document.getElementById('factorIcChartSelect');
  if(!select) return; if(!factorIcHistoryHost) return;
  const headerCells = factorIcHistoryHost.querySelectorAll('thead th');
  const factors=[]; headerCells.forEach((th,i)=> { if(i>0) factors.push(th.textContent); });
  select.innerHTML = '<option value="">(pick)</option>'+factors.map(f=> `<option>${f}</option>`).join('');
}
document.getElementById('factorIcChartRefresh')?.addEventListener('click', ()=> { rebuildFactorIcChart(); });
if(factorIcRefresh){ factorIcRefresh.addEventListener('click', ()=> { setTimeout(()=> { populateFactorIcChartSelect(); }, 50); }); }

// Portfolio PnL chart build from PnL table
function rebuildPortfolioPnlChart(){
  const canvas = document.getElementById('portfolioPnlChart'); if(!canvas) return;
  const tbl = portfolioPnlHost?.querySelector('table tbody'); if(!tbl) return;
  const rows = Array.from(tbl.querySelectorAll('tr'));
  const labels=[]; const values=[]; rows.forEach(r=> { const cells = r.querySelectorAll('td'); if(cells.length>=2){ const d=cells[0].textContent; const v=parseFloat(cells[1].textContent); if(d){ labels.push(d); values.push(Number.isFinite(v)?v:null); } } });
  ensureChart(canvas.getContext('2d'),'bar',{ labels, datasets:[{ label:'Daily Return', data: values, backgroundColor: values.map(v=> v==null? '#334155': v>=0?'#10b981':'#ef4444') }] }, { responsive:true, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } });
}
// Hook into portfolio performance load to update chart
if(portfolioPerfAuth){
  portfolioPerfAuth.addEventListener('submit', ()=> setTimeout(rebuildPortfolioPnlChart, 80));
}
if(portfolioPerfRefresh){
  portfolioPerfRefresh.addEventListener('click', ()=> setTimeout(rebuildPortfolioPnlChart, 80));
}
function correlationTable(factors, matrix){
  return `<table style='width:100%;border-collapse:collapse;font-size:10px;min-width:720px'>
    <thead style='position:sticky;top:0;background:#101726'><tr><th style='padding:4px 6px;text-align:left'>Factor</th>${factors.map(f=> `<th style='padding:4px 6px'>${f}</th>`).join('')}</tr></thead>
    <tbody>${matrix.map((row,i)=> `<tr><td style='padding:4px 6px;font-weight:600'>${factors[i]}</td>${row.map((v,j)=> {
      const val = v==null? null: Number(v);
      const color = val==null? '#334155': (val>0? `rgba(16,185,129,${Math.min(1,Math.abs(val))})`:`rgba(239,68,68,${Math.min(1,Math.abs(val))})`);
      return `<td style='padding:2px 4px;text-align:center;background:${color};color:#fff'>${val!=null? val.toFixed(2):''}</td>`; }).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

if(factorAnalyticsRefresh){
  factorAnalyticsRefresh.addEventListener('click', loadFactorAnalytics);
}

// --- Anomalies ---
const anomaliesRefresh = document.getElementById('anomaliesRefresh');
const anomaliesFilter = document.getElementById('anomaliesFilter');
const anomaliesBody = document.getElementById('anomaliesBody');
async function loadAnomalies(ev){
  if(ev) ev.preventDefault();
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  if(anomaliesBody) anomaliesBody.innerHTML = '<tr><td colspan="8" style="padding:10px;text-align:center;opacity:.6">Loading…</td></tr>';
  const fd = new FormData(anomaliesFilter);
  const status = fd.get('status');
  const qs = status? ('?status='+encodeURIComponent(status)) : '';
  try {
    const r = await fetchJSON('/admin/anomalies'+qs,{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    const rows = r.rows || r.anomalies || [];
    if(!rows.length){ anomaliesBody.innerHTML = '<tr><td colspan="8" style="padding:10px;text-align:center;opacity:.6">No anomalies</td></tr>'; return; }
    anomaliesBody.innerHTML = rows.slice(0,300).map(a=> anomalyRow(a)).join('');
    wireAnomalyActions();
  } catch(e){ anomaliesBody.innerHTML = '<tr><td colspan="8" style="padding:10px;text-align:center;color:#f87171">Load failed</td></tr>'; announce('Anomalies load failed','error'); }
}
function anomalyRow(a){
  return `<tr data-anomaly-id='${a.id}'>
    <td style='padding:4px 6px;font-family:monospace;font-size:10px'>${(a.id||'').toString().slice(0,8)}</td>
    <td style='padding:4px 6px'>${a.metric||''}</td>
    <td style='padding:4px 6px'>${a.observed!=null? a.observed:''}</td>
    <td style='padding:4px 6px'>${a.expected!=null? a.expected:''}</td>
    <td style='padding:4px 6px'>${a.status||''}</td>
    <td style='padding:4px 6px;font-size:10px;opacity:.75'>${(a.created_at||'').replace('T',' ').slice(0,16)}</td>
    <td style='padding:4px 6px;font-size:10px;max-width:160px;overflow:hidden;text-overflow:ellipsis'>${a.note||''}</td>
    <td style='padding:4px 6px;display:flex;gap:4px;flex-wrap:wrap'>
      <button data-anomaly-action='ack' style='background:#2563eb;border:1px solid #2563eb;color:#fff;font-size:10px;padding:4px 6px;border-radius:5px;cursor:pointer'>Ack</button>
      <button data-anomaly-action='dismiss' style='background:#16a34a;border:1px solid #16a34a;color:#fff;font-size:10px;padding:4px 6px;border-radius:5px;cursor:pointer'>Dismiss</button>
      <button data-anomaly-action='ignore' style='background:#b91c1c;border:1px solid #b91c1c;color:#fff;font-size:10px;padding:4px 6px;border-radius:5px;cursor:pointer'>Ignore</button>
    </td>
  </tr>`;
}
function wireAnomalyActions(){
  anomaliesBody?.querySelectorAll('tr').forEach(tr=> {
    tr.querySelectorAll('button[data-anomaly-action]').forEach(btn=> {
      btn.addEventListener('click', ()=> resolveAnomaly(tr.getAttribute('data-anomaly-id'), btn.getAttribute('data-anomaly-action')));
    });
  });
}
async function resolveAnomaly(id, action){
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  try {
    await fetchJSON('/admin/anomalies/resolve',{ method:'POST', headers:{ 'content-type':'application/json','x-admin-token': ADMIN_TOKEN }, body: JSON.stringify({ id, action }) });
    announce('Anomaly '+action,'success');
    loadAnomalies();
  } catch(e){ announce('Resolve failed','error'); }
}
if(anomaliesRefresh) anomaliesRefresh.addEventListener('click', loadAnomalies);
if(anomaliesFilter) anomaliesFilter.addEventListener('submit', loadAnomalies);

// --- Data Integrity ---
const integrityRefresh = document.getElementById('integrityRefresh');
const integrityFlags = document.getElementById('integrityFlags');
const integrityCoverage = document.getElementById('integrityCoverage');
const integrityLatest = document.getElementById('integrityLatest');
const integrityStatus = document.getElementById('integrityStatus');
async function loadIntegrity(){
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  if(integrityStatus) integrityStatus.textContent='Loading integrity…';
  try {
    const r = await fetchJSON('/admin/integrity',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    if(integrityFlags){
      integrityFlags.innerHTML = Object.entries(r.flags||{}).map(([k,v])=> `<span style='border:1px solid ${v?'#b91c1c':'#253349'};background:${v?'#7f1d1d':'#162132'};color:#e5ecf5;padding:4px 6px;border-radius:6px'>${k}: ${v? 'FAIL':'OK'}</span>`).join('') || '<span style="opacity:.6">No flags</span>';
    }
    if(integrityCoverage){
      integrityCoverage.innerHTML = Object.entries(r.coverage||{}).map(([k,v])=> `<div style='border:1px solid #253349;background:#162132;padding:6px 8px;border-radius:8px'><div style='font-size:10px;opacity:.6'>${k}</div><div style='font-size:12px;font-weight:600'>${v}</div></div>`).join('');
    }
    if(integrityLatest){
      integrityLatest.innerHTML = Object.entries(r.latest||{}).map(([k,v])=> `<div style='border:1px solid #253349;background:#162132;padding:6px 8px;border-radius:8px'><div style='font-size:10px;opacity:.6'>${k}</div><div style='font-size:12px;font-weight:600'>${v}</div></div>`).join('');
    }
    if(integrityStatus) integrityStatus.textContent='Integrity loaded';
    announce('Integrity loaded','success');
  } catch(e){ if(integrityStatus) integrityStatus.textContent='Integrity load failed'; announce('Integrity load failed','error'); }
}
if(integrityRefresh) integrityRefresh.addEventListener('click', loadIntegrity);

// --- Ingestion ---
const ingestionRefresh = document.getElementById('ingestionRefresh');
const ingestionStatus = document.getElementById('ingestionStatus');
const ingestionRunDue = document.getElementById('ingestionRunDue');
const ingestionRunFast = document.getElementById('ingestionRunFast');
const ingestionRunFull = document.getElementById('ingestionRunFull');
const ingestionMockPrices = document.getElementById('ingestionMockPrices');
const ingestionSchedules = document.getElementById('ingestionSchedules');
const ingestionConfigHost = document.getElementById('ingestionConfigHost');
const ingestionProvenanceHost = document.getElementById('ingestionProvenanceHost');
const ingestionConfigForm = document.getElementById('ingestionConfigForm');

async function loadIngestion(){
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  if(ingestionStatus) ingestionStatus.textContent='Loading ingestion…';
  await Promise.all([loadIngestionSchedules(), loadIngestionConfig(), loadIngestionProvenance()]);
  if(ingestionStatus) ingestionStatus.textContent='Ingestion loaded';
  announce('Ingestion loaded','success');
}
async function loadIngestionSchedules(){
  try { const r = await fetchJSON('/admin/ingestion-schedule',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    if(ingestionSchedules){
      ingestionSchedules.innerHTML = (r.rows||[]).map(s=> `<div style='border:1px solid #253349;background:#162132;padding:8px 10px;border-radius:8px;font-size:11px'>
        <div style='font-weight:600'>${s.dataset}</div>
        <div style='opacity:.7'>Freq ${s.frequency_minutes}m</div>
        <div style='opacity:.6;font-size:10px'>Last ${s.last_run_at? s.last_run_at.replace('T',' ').slice(0,16):'—'}</div>
      </div>`).join('') || '<div style="opacity:.6">No schedules</div>';
    }
  } catch(e){ if(ingestionSchedules) ingestionSchedules.innerHTML='<div style="color:#f87171">Schedules failed</div>'; }
}
async function loadIngestionConfig(){
  try { const r = await fetchJSON('/admin/ingestion/config',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    if(ingestionConfigHost){
      ingestionConfigHost.innerHTML = `<table style='width:100%;border-collapse:collapse;font-size:11px;min-width:600px'>
        <thead style='position:sticky;top:0;background:#101726'><tr><th style='text-align:left;padding:6px 8px'>Dataset</th><th style='text-align:left;padding:6px 8px'>Source</th><th style='text-align:left;padding:6px 8px'>Cursor</th><th style='text-align:left;padding:6px 8px'>Enabled</th></tr></thead>
        <tbody>${(r.rows||[]).map(c=> `<tr><td style='padding:4px 6px'>${c.dataset}</td><td style='padding:4px 6px'>${c.source}</td><td style='padding:4px 6px;font-size:10px'>${c.cursor||''}</td><td style='padding:4px 6px'>${c.enabled? '✅':'❌'}</td></tr>`).join('')||'<tr><td colspan="4" style="padding:6px 8px;opacity:.6">No config</td></tr>'}</tbody></table>`;
    }
  } catch(e){ if(ingestionConfigHost) ingestionConfigHost.innerHTML='<div style="color:#f87171;font-size:11px">Config failed</div>'; }
}
async function loadIngestionProvenance(){
  try { const r = await fetchJSON('/admin/ingestion/provenance?limit=100',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    if(ingestionProvenanceHost){
      ingestionProvenanceHost.innerHTML = `<table style='width:100%;border-collapse:collapse;font-size:10px;min-width:680px'>
        <thead style='position:sticky;top:0;background:#101726'><tr><th style='text-align:left;padding:6px 8px'>Dataset</th><th style='text-align:left;padding:6px 8px'>Source</th><th style='text-align:left;padding:6px 8px'>From</th><th style='text-align:left;padding:6px 8px'>To</th><th style='text-align:left;padding:6px 8px'>Rows</th><th style='text-align:left;padding:6px 8px'>Status</th><th style='text-align:left;padding:6px 8px'>At</th></tr></thead>
        <tbody>${(r.rows||[]).map(p=> `<tr><td style='padding:4px 6px'>${p.dataset}</td><td style='padding:4px 6px'>${p.source}</td><td style='padding:4px 6px'>${p.range_from||''}</td><td style='padding:4px 6px'>${p.range_to||''}</td><td style='padding:4px 6px'>${p.row_count||''}</td><td style='padding:4px 6px'>${p.status||''}</td><td style='padding:4px 6px'>${(p.created_at||'').replace('T',' ').slice(0,16)}</td></tr>`).join('')||'<tr><td colspan="7" style="padding:6px 8px;opacity:.6">No provenance</td></tr>'}</tbody></table>`;
    }
  } catch(e){ if(ingestionProvenanceHost) ingestionProvenanceHost.innerHTML='<div style="color:#f87171;font-size:11px">Provenance failed</div>'; }
}
async function runIngestionDue(){ if(!ADMIN_TOKEN) return announce('Admin token required','error'); try { await fetchJSON('/admin/ingestion-schedule/run-due?run=1',{ method:'POST', headers:{ 'x-admin-token': ADMIN_TOKEN } }); announce('Due ingestion run','success'); loadIngestion(); } catch(e){ announce('Run due failed','error'); } }
async function runIngestionFast(){ if(!ADMIN_TOKEN) return announce('Admin token required','error'); try { await fetchJSON('/admin/run-fast',{ method:'POST', headers:{ 'x-admin-token': ADMIN_TOKEN } }); announce('Fast run started','success'); } catch(e){ announce('Fast run failed','error'); } }
async function runIngestionFull(){ if(!ADMIN_TOKEN) return announce('Admin token required','error'); try { await fetchJSON('/admin/run-now',{ method:'POST', headers:{ 'x-admin-token': ADMIN_TOKEN } }); announce('Full run started','success'); } catch(e){ announce('Full run failed','error'); } }
async function mockPrices(){ if(!ADMIN_TOKEN) return announce('Admin token required','error'); try { await fetchJSON('/admin/ingest/prices',{ method:'POST', headers:{ 'x-admin-token': ADMIN_TOKEN } }); announce('Mock prices ingested','success'); } catch(e){ announce('Mock prices failed','error'); } }
if(ingestionRefresh) ingestionRefresh.addEventListener('click', loadIngestion);
if(ingestionRunDue) ingestionRunDue.addEventListener('click', runIngestionDue);
if(ingestionRunFast) ingestionRunFast.addEventListener('click', runIngestionFast);
if(ingestionRunFull) ingestionRunFull.addEventListener('click', runIngestionFull);
if(ingestionMockPrices) ingestionMockPrices.addEventListener('click', mockPrices);
if(ingestionConfigForm){
  ingestionConfigForm.addEventListener('submit', async ev=> {
    ev.preventDefault(); if(!ADMIN_TOKEN) return announce('Admin token required','error');
    const fd = new FormData(ingestionConfigForm);
    const body = { dataset: fd.get('dataset')?.toString().trim(), source: fd.get('source')?.toString().trim() };
    if(fd.get('cursor')) body.cursor = fd.get('cursor').toString().trim();
    if(fd.get('enabled')) body.enabled = fd.get('enabled').toString()==='1';
    try {
      await fetchJSON('/admin/ingestion/config',{ method:'POST', headers:{ 'content-type':'application/json','x-admin-token': ADMIN_TOKEN }, body: JSON.stringify(body) });
      announce('Config upserted','success');
      loadIngestionConfig();
    } catch(e){ announce('Config upsert failed','error'); }
  });
}

// --- Factor IC ---
const factorIcRefresh = document.getElementById('factorIcRefresh');
const factorIcSummaryHost = document.getElementById('factorIcSummaryHost');
const factorIcHistoryHost = document.getElementById('factorIcHistoryHost');
const factorIcStatus = document.getElementById('factorIcStatus');
async function loadFactorIC(){
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  if(factorIcStatus) factorIcStatus.textContent='Loading IC…';
  await Promise.all([loadFactorIcSummary(), loadFactorIcHistory()]);
  if(factorIcStatus) factorIcStatus.textContent='IC loaded';
  announce('Factor IC loaded','success');
}
async function loadFactorIcSummary(){
  try {
    const r = await fetchJSON('/admin/factor-ic/summary',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    const rows = r.rows||[];
    factorIcSummaryHost.innerHTML = `<table style='width:100%;border-collapse:collapse;font-size:10px;min-width:820px'>
      <thead style='position:sticky;top:0;background:#101726'><tr>
        <th style='text-align:left;padding:6px 8px'>Factor</th>
        <th style='text-align:left;padding:6px 8px'>IC Avg</th>
        <th style='text-align:left;padding:6px 8px'>IC Abs</th>
        <th style='text-align:left;padding:6px 8px'>IR</th>
        <th style='text-align:left;padding:6px 8px'>Hit</th>
        <th style='text-align:left;padding:6px 8px'>IC30</th>
        <th style='text-align:left;padding:6px 8px'>IC7</th>
      </tr></thead><tbody>
      ${rows.map(r=> `<tr><td style='padding:4px 6px;font-weight:600'>${r.factor}</td><td style='padding:4px 6px'>${fmtNum(r.ic_avg)}</td><td style='padding:4px 6px'>${fmtNum(r.ic_avg_abs)}</td><td style='padding:4px 6px'>${fmtNum(r.ic_ir)}</td><td style='padding:4px 6px'>${fmtNum(r.ic_hit)}</td><td style='padding:4px 6px'>${fmtNum(r.ic_avg_30d)}</td><td style='padding:4px 6px'>${fmtNum(r.ic_avg_7d)}</td></tr>`).join('')||'<tr><td colspan="7" style="padding:6px 8px;opacity:.6">No summary</td></tr>'}
      </tbody></table>`;
  } catch(e){ factorIcSummaryHost.innerHTML = '<div style="color:#f87171;font-size:11px;padding:8px">Summary failed</div>'; }
}
async function loadFactorIcHistory(){
  try {
    const r = await fetchJSON('/admin/factor-ic',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    const rows = r.rows||[];
    factorIcHistoryHost.innerHTML = `<table style='width:100%;border-collapse:collapse;font-size:9px;min-width:880px'>
      <thead style='position:sticky;top:0;background:#101726'><tr><th style='text-align:left;padding:4px 6px'>Date</th>${Array.from(new Set(rows.map(x=> x.factor))).sort().map(f=> `<th style='padding:4px 6px'>${f}</th>`).join('')}</tr></thead><tbody></tbody></table>`;
    const tbl = factorIcHistoryHost.querySelector('table tbody');
    const factors = Array.from(new Set(rows.map(x=> x.factor))).sort();
    const byDate = {};
    rows.forEach(r2=> { (byDate[r2.d] ||= {})[r2.factor]=r2.ic; });
    const dates = Object.keys(byDate).sort().slice(-120);
    tbl.innerHTML = dates.map(d=> `<tr><td style='padding:2px 4px;font-size:9px'>${d}</td>${factors.map(f=> {
      const v = byDate[d][f];
      const color = v==null? '#334155': (v>0? `rgba(16,185,129,${Math.min(1,Math.abs(v))})`:`rgba(239,68,68,${Math.min(1,Math.abs(v))})`);
      return `<td style='padding:2px 4px;text-align:center;background:${color};color:#fff'>${v!=null? v.toFixed(2):''}</td>`; }).join('')}</tr>`).join('');
  } catch(e){ factorIcHistoryHost.innerHTML = '<div style="color:#f87171;font-size:11px;padding:8px">History failed</div>'; }
}
if(factorIcRefresh) factorIcRefresh.addEventListener('click', loadFactorIC);

// --- Portfolio Performance (PnL & Attribution) ---
const portfolioPerfRefresh = document.getElementById('portfolioPerfRefresh');
const portfolioPerfAuth = document.getElementById('portfolioPerfAuth');
const portfolioPnlHost = document.getElementById('portfolioPnlHost');
const portfolioAttributionHost = document.getElementById('portfolioAttributionHost');
async function loadPortfolioPerformance(ev){
  if(ev) ev.preventDefault();
  const fd = new FormData(portfolioPerfAuth);
  const pid = fd.get('pid')?.toString().trim();
  const psec = fd.get('psec')?.toString().trim();
  const days = parseInt(fd.get('days'),10)||60;
  if(!pid||!psec) return announce('Portfolio creds required','error');
  const headers = { 'x-portfolio-id': pid, 'x-portfolio-secret': psec };
  try {
    const pnl = await fetchJSON('/portfolio/pnl?days='+days,{ headers });
    renderPnlTable(pnl.rows||[]);
  } catch(e){ portfolioPnlHost.innerHTML = '<div style="color:#f87171;font-size:11px;padding:8px">PnL failed</div>'; }
  try {
    const attrib = await fetchJSON('/portfolio/attribution',{ headers });
    renderAttributionTable(attrib.rows||[]);
  } catch(e){ portfolioAttributionHost.innerHTML = '<div style="color:#f87171;font-size:11px;padding:8px">Attribution failed</div>'; }
  announce('Portfolio performance loaded','success');
}
function renderPnlTable(rows){
  if(!rows.length){ portfolioPnlHost.innerHTML = '<div style="font-size:11px;opacity:.6;padding:8px">No PnL rows</div>'; return; }
  portfolioPnlHost.innerHTML = `<table style='width:100%;border-collapse:collapse;font-size:10px;min-width:560px'>
    <thead style='position:sticky;top:0;background:#101726'><tr><th style='text-align:left;padding:4px 6px'>Date</th><th style='text-align:left;padding:4px 6px'>Ret</th><th style='text-align:left;padding:4px 6px'>Turnover</th><th style='text-align:left;padding:4px 6px'>Realized</th></tr></thead>
    <tbody>${rows.slice(-180).map(r=> `<tr><td style='padding:2px 4px'>${r.as_of||r.d}</td><td style='padding:2px 4px'>${fmtNum(r.ret)}</td><td style='padding:2px 4px'>${fmtNum(r.turnover_cost)}</td><td style='padding:2px 4px'>${fmtNum(r.realized_pnl)}</td></tr>`).join('')}</tbody></table>`;
}
function renderAttributionTable(rows){
  if(!rows.length){ portfolioAttributionHost.innerHTML = '<div style="font-size:11px;opacity:.6;padding:8px">No attribution rows</div>'; return; }
  // Group by date; show factor contributions stacked per date
  const byDate={}; rows.forEach(r=> { (byDate[r.as_of] ||= []).push(r); });
  const dates = Object.keys(byDate).sort().slice(-90);
  portfolioAttributionHost.innerHTML = `<table style='width:100%;border-collapse:collapse;font-size:10px;min-width:620px'>
    <thead style='position:sticky;top:0;background:#101726'><tr><th style='text-align:left;padding:4px 6px'>Date</th><th style='text-align:left;padding:4px 6px'>Contributions</th></tr></thead>
    <tbody>${dates.map(d=> `<tr><td style='padding:2px 4px'>${d}</td><td style='padding:2px 4px'>${byDate[d].map(c=> `<span style='border:1px solid #253349;background:#162132;padding:2px 4px;border-radius:4px;margin:2px;display:inline-block'>${c.factor}: ${fmtNum(c.contribution)}</span>`).join('')}</td></tr>`).join('')}</tbody></table>`;
}
if(portfolioPerfAuth) portfolioPerfAuth.addEventListener('submit', loadPortfolioPerformance);
if(portfolioPerfRefresh) portfolioPerfRefresh.addEventListener('click', loadPortfolioPerformance);

// --- Backtests ---
const backtestsRefresh = document.getElementById('backtestsRefresh');
const backtestsHost = document.getElementById('backtestsHost');
const backtestDetailHost = document.getElementById('backtestDetailHost');
async function loadBacktests(){
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  backtestsHost.innerHTML = '<div style="padding:8px;font-size:11px;opacity:.6">Loading…</div>';
  try {
    const r = await fetchJSON('/admin/backtests',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    const rows = r.rows || r.backtests || [];
    if(!rows.length){ backtestsHost.innerHTML = '<div style="padding:8px;font-size:11px;opacity:.6">No backtests</div>'; return; }
    backtestsHost.innerHTML = `<table style='width:100%;border-collapse:collapse;font-size:10px;min-width:700px'>
      <thead style='position:sticky;top:0;background:#101726'><tr><th style='text-align:left;padding:4px 6px'>ID</th><th style='text-align:left;padding:4px 6px'>Factor</th><th style='text-align:left;padding:4px 6px'>Span</th><th style='text-align:left;padding:4px 6px'>Ret</th><th style='text-align:left;padding:4px 6px'>Sharpe</th><th style='text-align:left;padding:4px 6px'>Created</th><th style='text-align:left;padding:4px 6px'>Actions</th></tr></thead>
      <tbody>${rows.slice(0,200).map(b=> `<tr data-backtest-id='${b.id}'>
        <td style='padding:2px 4px;font-family:monospace'>${(b.id||'').toString().slice(0,8)}</td>
        <td style='padding:2px 4px'>${b.factor||''}</td>
        <td style='padding:2px 4px'>${b.days||''}</td>
        <td style='padding:2px 4px'>${fmtNum(b.ret)}</td>
        <td style='padding:2px 4px'>${fmtNum(b.sharpe)}</td>
        <td style='padding:2px 4px;font-size:9px'>${(b.created_at||'').replace('T',' ').slice(0,16)}</td>
        <td style='padding:2px 4px'><button data-backtest-detail='${b.id}' style='background:#2563eb;border:1px solid #2563eb;color:#fff;font-size:10px;padding:4px 6px;border-radius:5px;cursor:pointer'>Detail</button></td>
      </tr>`).join('')}</tbody></table>`;
    backtestsHost.querySelectorAll('button[data-backtest-detail]').forEach(btn=> btn.addEventListener('click', ()=> loadBacktestDetail(btn.getAttribute('data-backtest-detail'))));
  } catch(e){ backtestsHost.innerHTML = '<div style="color:#f87171;font-size:11px;padding:8px">Backtests load failed</div>'; }
}
async function loadBacktestDetail(id){
  if(!ADMIN_TOKEN) return;
  backtestDetailHost.innerHTML = '<div style="padding:8px;font-size:11px;opacity:.6">Loading detail…</div>';
  try {
    const r = await fetchJSON(`/admin/backtests/${encodeURIComponent(id)}`,{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    // Guess structure; display JSON pretty.
    backtestDetailHost.innerHTML = `<pre style='margin:0;font-size:10px;white-space:pre-wrap;word-break:break-word;padding:8px'>${escapeHtml(JSON.stringify(r,null,2)).slice(0,8000)}</pre>`;
  } catch(e){ backtestDetailHost.innerHTML = '<div style="color:#f87171;font-size:11px;padding:8px">Detail load failed</div>'; }
}
if(backtestsRefresh) backtestsRefresh.addEventListener('click', loadBacktests);

// --- Audit Trail ---
const auditRefresh = document.getElementById('auditRefresh');
const auditFilter = document.getElementById('auditFilter');
const auditHost = document.getElementById('auditHost');
const auditStatsBtn = document.getElementById('auditStatsBtn');
const auditStats = document.getElementById('auditStats');
async function loadAudit(ev){
  if(ev) ev.preventDefault();
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  auditHost.innerHTML = '<div style="padding:8px;font-size:11px;opacity:.6">Loading…</div>';
  const fd = new FormData(auditFilter);
  const params = new URLSearchParams();
  ['resource','action','actor_type','limit'].forEach(k=> { const v = fd.get(k); if(v) params.append(k,v.toString()); });
  try {
    const r = await fetchJSON('/admin/audit'+(params.toString()? '?'+params.toString():''),{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    const rows = r.rows || [];
    if(!rows.length){ auditHost.innerHTML='<div style="padding:8px;font-size:11px;opacity:.6">No audit rows</div>'; return; }
    auditHost.innerHTML = `<table style='width:100%;border-collapse:collapse;font-size:10px;min-width:820px'>
      <thead style='position:sticky;top:0;background:#101726'><tr><th style='text-align:left;padding:4px 6px'>Time</th><th style='text-align:left;padding:4px 6px'>Resource</th><th style='text-align:left;padding:4px 6px'>Action</th><th style='text-align:left;padding:4px 6px'>Actor</th><th style='text-align:left;padding:4px 6px'>Resource ID</th><th style='text-align:left;padding:4px 6px'>Meta</th></tr></thead>
      <tbody>${rows.slice(0,500).map(a=> `<tr><td style='padding:2px 4px'>${(a.ts||'').replace('T',' ').slice(0,19)}</td><td style='padding:2px 4px'>${a.resource||''}</td><td style='padding:2px 4px'>${a.action||''}</td><td style='padding:2px 4px'>${a.actor_type||''}</td><td style='padding:2px 4px;font-size:9px'>${a.resource_id||''}</td><td style='padding:2px 4px;font-size:9px;max-width:240px;overflow:hidden;text-overflow:ellipsis'>${formatMeta(a.meta)}</td></tr>`).join('')}</tbody></table>`;
  } catch(e){ auditHost.innerHTML = '<div style="color:#f87171;font-size:11px;padding:8px">Audit load failed</div>'; }
}
async function loadAuditStats(){
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  auditStats.textContent='Loading stats…';
  try { const r = await fetchJSON('/admin/audit/stats',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    auditStats.innerHTML = Object.entries(r.counts||r.stats||{}).slice(0,12).map(([k,v])=> `<span style='border:1px solid #253349;background:#162132;padding:4px 6px;border-radius:6px;margin:2px;font-size:10px'>${k}: ${v}</span>`).join('')||'No stats';
  } catch(e){ auditStats.textContent='Stats failed'; announce('Audit stats failed','error'); }
}
if(auditFilter) auditFilter.addEventListener('submit', loadAudit);
if(auditRefresh) auditRefresh.addEventListener('click', loadAudit);
if(auditStatsBtn) auditStatsBtn.addEventListener('click', loadAuditStats);

// Helpers
function escapeHtml(s){ return s?.replace(/[&<>"']/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]) ); }
function formatMeta(m){ if(!m) return ''; if(typeof m==='string') return m.slice(0,80); try { return JSON.stringify(m).slice(0,120); } catch(e){ return ''; } }

// --- Alerts Admin Panel ---
const alertAdminBody = document.getElementById('alertAdminBody');
const alertAdminFilters = document.getElementById('alertAdminFilters');
const alertAdminStatsBtn = document.getElementById('alertAdminStatsBtn');
const alertAdminStats = document.getElementById('alertAdminStats');

async function loadAdminAlerts(e){
  if(e) e.preventDefault();
  if(!ADMIN_TOKEN){ announce('Set admin token first','error'); return; }
  if(alertAdminBody) alertAdminBody.innerHTML = '<tr><td colspan="9" style="padding:12px;text-align:center;opacity:.6">Loading…</td></tr>';
  const fd = new FormData(alertAdminFilters);
  const params = new URLSearchParams();
  for(const [k,v] of fd.entries()){ if(v) params.append(k, v.toString()); }
  try {
    const r = await fetchJSON('/admin/alerts'+(params.toString()? ('?'+params.toString()):''), { headers: { 'x-admin-token': ADMIN_TOKEN } });
    if(!alertAdminBody) return;
    const rows = r.rows||[];
    if(!rows.length){ alertAdminBody.innerHTML = '<tr><td colspan="9" style="padding:12px;text-align:center;opacity:.6">No alerts</td></tr>'; return; }
    alertAdminBody.innerHTML = rows.slice(0,400).map(a=> alertRow(a)).join('');
    wireAlertActions();
  } catch(err){ if(alertAdminBody) alertAdminBody.innerHTML = '<tr><td colspan="9" style="padding:12px;text-align:center;color:#f87171">Load failed</td></tr>'; announce('Alerts load failed','error'); }
}

function alertRow(a){
  return `<tr data-alert-id='${a.id}'>
    <td style='padding:4px 6px;font-family:monospace;font-size:10px'>${a.id.slice(0,8)}</td>
    <td style='padding:4px 6px'>${a.email||''}</td>
    <td style='padding:4px 6px'>${a.card_id||''}</td>
    <td style='padding:4px 6px'>${a.kind||''}</td>
    <td style='padding:4px 6px'>${a.threshold!=null? a.threshold:''}</td>
    <td style='padding:4px 6px'>${a.active? '✅':'❌'}</td>
    <td style='padding:4px 6px;font-size:10px;${a.suppressed_until?'':'opacity:.4'}'>${a.suppressed_until? a.suppressed_until.replace('T',' ').slice(0,16):'—'}</td>
    <td style='padding:4px 6px'>${a.fired_count!=null? a.fired_count:''}</td>
    <td style='padding:4px 6px;display:flex;gap:4px;flex-wrap:wrap'>
      <button data-alert-action='deactivate' style='background:#b91c1c;border:1px solid #b91c1c;color:#fff;font-size:10px;padding:4px 6px;border-radius:5px;cursor:pointer'>Deactivate</button>
      <button data-alert-action='snooze' style='background:#2563eb;border:1px solid #2563eb;color:#fff;font-size:10px;padding:4px 6px;border-radius:5px;cursor:pointer'>Snooze</button>
    </td>
  </tr>`;
}

function wireAlertActions(){
  alertAdminBody?.querySelectorAll('tr').forEach(tr=> {
    tr.querySelectorAll('button[data-alert-action]').forEach(btn=> {
      btn.addEventListener('click', ()=> handleAlertAction(tr.getAttribute('data-alert-id'), btn.getAttribute('data-alert-action')));
    });
  });
}

async function handleAlertAction(id, action){
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  try {
    if(action==='deactivate'){
      await fetchJSON(`/alerts/deactivate?id=${encodeURIComponent(id)}`,{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
      announce('Alert deactivated','success');
    } else if(action==='snooze'){
      const minutes = prompt('Snooze minutes (max 10080):','60');
      if(!minutes) return; const mins = parseInt(minutes,10); if(!Number.isFinite(mins)||mins<1) return announce('Bad minutes','error');
      // Snooze requires POST with minutes + token; admin may not have manage token. Attempt anyway.
      await fetchJSON(`/alerts/snooze?id=${encodeURIComponent(id)}`,{ method:'POST', headers:{ 'content-type':'application/json','x-admin-token': ADMIN_TOKEN }, body: JSON.stringify({ minutes: mins, token: 'admin' }) });
      announce('Alert snoozed','success');
    }
    loadAdminAlerts();
  } catch(e){ announce('Action failed','error'); }
}

async function loadAlertStats(){
  if(!ADMIN_TOKEN) return announce('Admin token required','error');
  if(alertAdminStats) alertAdminStats.textContent = 'Loading stats…';
  try {
    const r = await fetchJSON('/admin/alerts/stats',{ headers:{ 'x-admin-token': ADMIN_TOKEN } });
    if(alertAdminStats){
      alertAdminStats.innerHTML = `<strong>${r.total}</strong> total • active ${r.active} • suppressed ${r.suppressed} • unsuppressed ${r.active_unsuppressed} • escalations >=5:${r.escalation?.ge5} >=10:${r.escalation?.ge10} >=25:${r.escalation?.ge25}`;
    }
  } catch(e){ if(alertAdminStats) alertAdminStats.textContent='Stats unavailable'; announce('Alert stats failed','error'); }
}

if(alertAdminFilters){
  alertAdminFilters.addEventListener('submit', loadAdminAlerts);
}
if(alertAdminStatsBtn){
  alertAdminStatsBtn.addEventListener('click', loadAlertStats);
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
window.PQv2 = { state, reloadMovers: loadMovers, loadCards, openCard, loadPortfolio, addLot, updateLot, deleteLot, loadPortfolioTargetsAndExposures, saveTargetsFromUI, createPortfolioOrder, loadPortfolioOrders, loadAdminAlerts, loadAlertStats, loadFactorAnalytics, loadAnomalies, loadIntegrity, loadIngestion, loadFactorIC, loadBacktests, loadAudit, loadPortfolioPerformance, loadFactorWeights, rebuildFactorIcChart, rebuildPortfolioPnlChart };

console.log('%cPokeQuant v'+VERSION,'background:#6366f1;color:#fff;padding:2px 6px;border-radius:4px');
