// health.js (v0.7.2)
import { fetchJSON } from './core.js';

export async function loadHealth(){
  const host = document.getElementById('healthInfo'); if(host) host.textContent='Loading health…';
  try {
    const j = await fetchJSON('/health');
    const latest = j.latest || {};
    const parts = [];
    if(latest.prices_daily?.d) parts.push('prices '+latest.prices_daily.d);
    if(latest.signals_daily?.d) parts.push('signals '+latest.signals_daily.d);
    if(latest.svi_daily?.d) parts.push('svi '+latest.svi_daily.d);
    if(host) host.textContent = parts.length? 'Data up to '+parts.join(' | ') : 'OK';
  } catch(e){ if(host) host.textContent='Health unavailable'; }
}

loadHealth();
