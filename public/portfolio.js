// Portfolio module (v0.8.9) - minimal scaffold
import { fetchJSON, fmtUSD } from './core.js';
import { setSlice } from './store.js';

export async function loadPortfolio(){
  const sumEl = document.getElementById('portfolioSummary');
  const lotsEl = document.getElementById('portfolioLots');
  if(sumEl) sumEl.textContent = 'Loading portfolio…';
  try {
    // Attempt summary endpoints; fallback sequence
    let lots = [];
  try { lots = await fetchJSON('/portfolio/lots', { ttlMs: 60_000 }); } catch {}
    // Derive simple aggregates
    const totalLots = lots.length;
    const totalValue = lots.reduce((a,l)=> a + (Number(l.value_usd)||0),0);
  if(sumEl) sumEl.innerHTML = `<strong>${totalLots}</strong> lots • <strong>${fmtUSD(totalValue)}</strong> total value`;
  try { setSlice('portfolioLots', lots); } catch {}
    if(lotsEl){
      if(!lots.length){ lotsEl.innerHTML = '<div style="opacity:.6">No lots found.</div>'; }
      else {
        lotsEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:11px;min-width:520px">
          <thead><tr style="text-align:left"><th style="padding:4px 6px">Card</th><th style="padding:4px 6px">Qty</th><th style="padding:4px 6px">Value</th><th style="padding:4px 6px">Last Price</th></tr></thead>
          <tbody>${lots.slice(0,100).map(r=> `<tr>
            <td style="padding:4px 6px">${r.card_id||r.card||''}</td>
            <td style="padding:4px 6px">${r.quantity||r.qty||1}</td>
            <td style="padding:4px 6px">${fmtUSD(r.value_usd)}</td>
            <td style="padding:4px 6px">${fmtUSD(r.last_price_usd)}</td>
          </tr>`).join('')}</tbody></table>`;
      }
    }
  } catch(e){
    if(sumEl) sumEl.innerHTML = '<span style="color:#f87171">Failed to load portfolio</span>';
  }
}

// Auto-wire navigation lazy load
document.addEventListener('click', e=> {
  const btn = e.target.closest('[data-view="portfolio"]');
  if(btn){ loadPortfolio(); }
});
