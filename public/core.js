// Core bootstrap for PokeQuant 0.8.9 (SPA Phase 2)
export const API_BASE = 'https://pokequant.jonathanbarreneche.workers.dev';
export const VERSION = '0.8.9';
export const PLACEHOLDER = '/placeholder-card.svg';

export function qs(sel, root=document){ return root.querySelector(sel); }
export function qsa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

export function fmtUSD(x){ return (x==null||isNaN(Number(x)))?'—':'$'+Number(x).toFixed(2); }
export function abbreviateSet(name){ if(!name) return ''; return name.split(/\s+/).map(w=> w[0]).join('').slice(0,4).toUpperCase(); }

// Simple in-memory cache with ETag support
const _cache = new Map(); // key -> { data, etag, ts }

// Stale-While-Revalidate wrapper: returns cached data immediately (if fresh within ttlMs), triggers background revalidation.
export async function swr(path, opts={}) {
  const ttlMs = opts.ttlMs || 60_000;
  const key = path;
  const now = performance.now();
  const existing = _cache.get(key);
  if (existing && (now - existing.ts) < ttlMs) {
    // Fire revalidation in background (ignore errors) if stale threshold passed (half ttl)
    if ((now - existing.ts) > ttlMs * 0.5) {
      revalidate(key, path, opts).catch(()=>{});
    }
    return existing.data;
  }
  return fetchJSON(path, opts); // falls through to normal path (sets cache)
}
async function revalidate(key, path, opts){
  try { await fetchJSON(path, opts); } catch {/* ignore background errors */}
}

export async function fetchJSON(path, opts){
  const cacheKey = path;
  const ttlMs = (opts && opts.ttlMs) || 0; // custom TTL override via extended opts
  const existing = _cache.get(cacheKey);
  const now = performance.now();
  if (existing && ttlMs && (now - existing.ts) < ttlMs) {
    return existing.data;
  }
  const headers = { 'accept':'application/json', ...(opts?.headers||{}) };
  if (existing?.etag) headers['if-none-match'] = existing.etag;
  const started = now;
  const r = await fetch(API_BASE + path, { ...opts, headers });
  if (r.status === 304 && existing) {
    existing.ts = now; // refresh staleness timestamp
    return existing.data;
  }
  let j=null; try { j = await r.json(); } catch {}
  if(!r.ok){ const msg=(j&&j.error)||`HTTP ${r.status}`; console.warn('fetchJSON error', path, msg); throw new Error(msg); }
  const etag = r.headers.get('etag') || r.headers.get('ETag');
  _cache.set(cacheKey, { data:j, etag, ts: now });
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
