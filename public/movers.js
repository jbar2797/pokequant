// Movers module (v0.7.4)
import { fetchJSON, signalBadge, fmtUSD, abbreviateSet, PLACEHOLDER } from './core.js';

export async function loadMovers(){
  const hostUp = document.getElementById('moversUp');
  const hostDown = document.getElementById('moversDown');
  if(hostUp) hostUp.innerHTML = skeleton();
  if(hostDown) hostDown.innerHTML = skeleton();
  try {
    const [up,down] = await Promise.all([
      fetchJSON('/api/movers?n=12'), fetchJSON('/api/movers?dir=down&n=12')
    ]);
    if(hostUp) hostUp.innerHTML = up.length ? up.map(tile).join('') : empty('No movers');
    if(hostDown) hostDown.innerHTML = down.length ? down.map(tile).join('') : empty('No losers');
    document.dispatchEvent(new CustomEvent('pq:movers:loaded'));
  } catch(e){
    if(hostUp) hostUp.innerHTML = errorBox('Failed to load movers');
    if(hostDown) hostDown.innerHTML = errorBox('Failed to load losers');
  }
}

function tile(c){
  const price = (c.price_usd!=null)?fmtUSD(c.price_usd):(c.price_eur!=null?'€'+Number(c.price_eur).toFixed(2):'—');
  const setAb = abbreviateSet(c.set_name);
  const number = c.number || '';
  const img = c.image_url || PLACEHOLDER;
  return `<div class="tile fade-in" data-card-id="${c.id}">
    <img src="${img}" alt="${c.name}" loading="lazy" onerror="this.src='${PLACEHOLDER}'"/>
    <div class="nm" title="${c.name}">${c.name}</div>
    <div class="meta">${setAb}${number? ' · #'+number:''}</div>
    <div class="row"><span class="price">${price}</span>${signalBadge(c.signal)}</div>
  </div>`;
}
function skeleton(n=8){ return Array.from({length:n}).map(()=> `<div class="tile skel" style="height:170px"></div>`).join(''); }
const empty = (m)=> `<div class="text-dim" style="font-size:11px;opacity:.7">${m}</div>`;
const errorBox = (m)=> `<div style="font-size:11px;color:#f87171">${m}</div>`;

// delegate click for card detail events
export function wireMoversClicks(cb){
  document.addEventListener('click', e=> {
    const t = e.target.closest('.tile[data-card-id]');
    if(!t) return; cb && cb(t.getAttribute('data-card-id'));
  });
}
