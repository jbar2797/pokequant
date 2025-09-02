import React from 'react';
import { cn } from '../utils';
type Signal = 'buy' | 'hold' | 'sell';
const COLORS: Record<Signal, string> = {
  buy: 'text-success',
  hold: 'text-neutral',
  sell: 'text-danger'
};
const ICON: Record<Signal, string> = { buy: '↑', hold: '—', sell: '↓' };
export interface SignalBadgeProps { signal: Signal; className?: string; }
export const SignalBadge: React.FC<SignalBadgeProps> = ({ signal, className }) => (
  <span
    aria-label={`Signal: ${signal.charAt(0).toUpperCase()}${signal.slice(1)}`}
    className={cn('inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium', COLORS[signal], className)}
  >
    <span aria-hidden>{ICON[signal]}</span>{signal.charAt(0).toUpperCase() + signal.slice(1)}
  </span>
);