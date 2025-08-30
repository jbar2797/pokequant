// Core bootstrap for PokeQuant 0.7.4
export const API_BASE = 'https://pokequant.jonathanbarreneche.workers.dev';
export const VERSION = '0.7.4';
export const PLACEHOLDER = '/placeholder-card.svg';

export function qs(sel, root=document){ return root.querySelector(sel); }
export function qsa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

export function fmtUSD(x){ return (x==null||isNaN(Number(x)))?'—':'$'+Number(x).toFixed(2); }
export function abbreviateSet(name){ if(!name) return ''; return name.split(/\s+/).map(w=> w[0]).join('').slice(0,4).toUpperCase(); }

export async function fetchJSON(path, opts){
  const started = performance.now();
  const r = await fetch(API_BASE + path, { headers:{ 'accept':'application/json', ...(opts?.headers||{}) }, ...opts });
  let j=null; try { j = await r.json(); } catch {}
  if(!r.ok){ const msg=(j&&j.error)||`HTTP ${r.status}`; console.warn('fetchJSON error', path, msg); throw new Error(msg); }
  const ms = performance.now()-started;
  if(ms>1500) console.log('[slow]', path, ms.toFixed(0)+'ms');
  return j;
}

export function signalBadge(sig){
  const s=(sig||'HOLD').toUpperCase();
  if(s==='BUY') return '<span class="badge badge-buy">BUY</span>';
  if(s==='SELL') return '<span class="badge badge-sell">SELL</span>';
  return '<span class="badge badge-hold">HOLD</span>';
}
