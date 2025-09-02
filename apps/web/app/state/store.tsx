"use client";
import React, {createContext, useContext, useState, useCallback, useEffect, useRef} from 'react';

export interface PortfolioHolding { id: string; name: string; quantity: number; basis: number; }
export interface AlertRule { id: string; type: string; threshold: number; direction?: string; window?: string; }

interface AppStateContextValue {
  portfolio: PortfolioHolding[];
  alerts: AlertRule[];
  watchlist: string[];
  theme: 'light' | 'dark';
  addHolding: (h: Omit<PortfolioHolding,'id'>) => PortfolioHolding;
  removeHolding: (id: string) => void;
  addAlert: (a: Omit<AlertRule,'id'>) => AlertRule;
  removeAlert: (id: string) => void;
  toggleWatch: (cardId: string) => void;
  isWatched: (cardId: string) => boolean;
  moveWatch: (cardId: string, dir: 'up'|'down') => void;
  setTheme: (t: 'light'|'dark') => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export const AppStateProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [portfolio, setPortfolio] = useState<PortfolioHolding[]>([]);
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [theme, setThemeState] = useState<'light'|'dark'>('light');
  const hydrated = useRef(false);

  // Hydrate from localStorage once
  useEffect(()=> {
    if (hydrated.current) return;
    try {
      const raw = localStorage.getItem('appState');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.portfolio) setPortfolio(parsed.portfolio);
        if (parsed.alerts) setAlerts(parsed.alerts);
  if (parsed.watchlist) setWatchlist(parsed.watchlist);
  if (parsed.theme) setThemeState(parsed.theme);
      }
    } catch { /* noop */ }
    hydrated.current = true;
  }, []);

  // Persist
  useEffect(()=> {
    if (!hydrated.current) return; // avoid overwriting during initial load
    try { localStorage.setItem('appState', JSON.stringify({ portfolio, alerts, watchlist, theme })); } catch { /* noop */ }
  }, [portfolio, alerts, watchlist, theme]);

  const addHolding = useCallback((h: Omit<PortfolioHolding,'id'>) => {
    const newHolding: PortfolioHolding = {id: crypto.randomUUID(), ...h};
    setPortfolio(prev => [...prev, newHolding]);
    return newHolding;
  }, []);
  const removeHolding = useCallback((id: string) => setPortfolio(p => p.filter(x => x.id!==id)), []);
  const addAlert = useCallback((a: Omit<AlertRule,'id'>) => {
    const newAlert: AlertRule = {id: crypto.randomUUID(), ...a};
    setAlerts(prev => [...prev, newAlert]);
    return newAlert;
  }, []);
  const removeAlert = useCallback((id: string) => setAlerts(p => p.filter(x => x.id!==id)), []);

  const toggleWatch = useCallback((cardId: string) => setWatchlist(w => w.includes(cardId)? w.filter(i=>i!==cardId): [...w, cardId]), []);
  const isWatched = useCallback((cardId: string) => watchlist.includes(cardId), [watchlist]);
  const moveWatch = useCallback((cardId: string, dir: 'up'|'down') => {
    setWatchlist(w => {
      const idx = w.indexOf(cardId); if (idx === -1) return w;
      const target = dir==='up'? idx-1 : idx+1;
      if (target < 0 || target >= w.length) return w;
      const copy = [...w];
      const [item] = copy.splice(idx,1);
      copy.splice(target,0,item);
      return copy;
    });
  }, []);
  const setTheme = useCallback((t:'light'|'dark') => setThemeState(t), []);

  return <AppStateContext.Provider value={{portfolio, alerts, watchlist, theme, addHolding, removeHolding, addAlert, removeAlert, toggleWatch, isWatched, moveWatch, setTheme}}>{children}</AppStateContext.Provider>;
};

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if(!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}
