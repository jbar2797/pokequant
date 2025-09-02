import { type ClassValue } from 'clsx';
import clsx from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatPrice(v: number, currency: string = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
}
export function formatPct(v: number, opts: { sign?: boolean } = {}) {
  const sign = opts.sign ? (v > 0 ? '+' : '') : '';
  return `${sign}${(v * 100).toFixed(2)}%`;
}
export function formatDate(d: Date | string) {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// useResponsiveGrid moved to hooks/responsive.tsx (client only)