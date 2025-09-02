// Central in-memory store with simple pub/sub and entity caches (Phase 2.5)
const subs = new Set();
const state = {
  cards: null,
  moversUp: null,
  moversDown: null,
  portfolioLots: null,
  updated: {}
};

export function getState(){ return state; }
export function subscribe(fn){ subs.add(fn); return () => subs.delete(fn); }
function emit(){ for (const fn of subs) { try { fn(state); } catch {} } }

export function setSlice(key, value){ state[key] = value; state.updated[key] = Date.now(); emit(); }

// Derive convenience selectors
export const selectors = {
  cardById: (id)=> (state.cards||[]).find(c=> c.id===id),
  movers: ()=> ({ up: state.moversUp||[], down: state.moversDown||[] }),
  portfolioLots: ()=> state.portfolioLots||[]
};

// Expose for debugging
window.PQStore = { getState, setSlice, subscribe, selectors };