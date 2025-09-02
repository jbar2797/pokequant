// Lightweight hash router (Phase 2 SPA scaffold)
// Routes: #/overview, #/cards, #/portfolio, #/card/<id>

const listeners = new Set();
export function onRoute(fn){ listeners.add(fn); return () => listeners.delete(fn); }

export function currentRoute(){
  const hash = window.location.hash || '#/overview';
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0]==='card' && parts[1]) return { name:'card', id: decodeURIComponent(parts.slice(1).join('/')) };
  const simple = parts[0]||'overview';
  if(['overview','cards','portfolio'].includes(simple)) return { name:simple };
  return { name:'overview' };
}

export function navigate(to){
  if (to.startsWith('#')) window.location.hash = to; else window.location.hash = '#'+to.replace(/^#/, '');
}

function emit(){ const r = currentRoute(); for (const fn of listeners) { try { fn(r); } catch {} } }

window.addEventListener('hashchange', emit);
// Initial dispatch after microtask to allow subscribers.
setTimeout(emit, 0);

// Expose for debugging
window.PQRoute = { navigate, currentRoute };