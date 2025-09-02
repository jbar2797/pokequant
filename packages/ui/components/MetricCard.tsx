import React from 'react';
import { formatPct } from '../utils';
import { Skeleton } from './Feedback';

export interface MetricCardProps {
  label: string; value?: string | number; delta?: number; loading?: boolean; compact?: boolean;
}
export const MetricCard: React.FC<MetricCardProps> = ({ label, value, delta, loading, compact }) => {
  if (loading) return <div className="rounded-md border border-border p-3"><Skeleton lines={compact?1:2} /></div>;
  return (
    <div className="rounded-md border border-border bg-card p-3 shadow-sm">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-1 flex items-end gap-2">
        <span className={compact? 'text-base font-semibold':'text-xl font-semibold'}>{typeof value==='number'? value.toLocaleString():value}</span>
        {typeof delta === 'number' && <span className={delta>=0? 'text-success text-xs':'text-danger text-xs'}>{formatPct(delta,{sign:true})}</span>}
      </div>
    </div>
  );
};