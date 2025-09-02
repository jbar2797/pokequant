"use client";
import React from 'react';
import { cn } from '../utils';
// Consumers inside app can pass a hook bridging to global state; keep component library decoupled.
export const WatchlistButton: React.FC<{ cardId: string; active?: boolean; onToggle?: (id:string)=>void }> = ({ cardId, active=false, onToggle }) => {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={active ? 'Remove from watchlist' : 'Add to watchlist'}
      onClick={() => onToggle?.(cardId)}
      className={cn('rounded-md border px-2 py-1 text-[11px] font-medium transition-colors', active ? 'bg-brand text-white border-brand' : 'bg-card hover:bg-brand/10 border-border')}
    >{active? 'Watching':'Watch'}</button>
  );
};