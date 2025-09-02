"use client";
import React, { useState } from 'react';
import { cn } from '../utils';

export interface TabSpec { id: string; label: string; content: React.ReactNode; }
export const Tabs: React.FC<{ tabs: TabSpec[]; defaultId?: string; onChange?(id:string):void }> = ({ tabs, defaultId, onChange }) => {
  const [active, setActive] = useState(defaultId || tabs[0]?.id);
  return (
    <div>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map(t => (
          <button key={t.id} role="tab" aria-selected={t.id===active} onClick={()=>{setActive(t.id); onChange?.(t.id);}} className={cn('rounded-t-md px-3 py-1 text-sm font-medium', t.id===active ? 'bg-card border border-border border-b-bg' : 'text-muted hover:text-fg')}>{t.label}</button>
        ))}
      </div>
      <div className="mt-3" role="tabpanel" aria-labelledby={active}>{tabs.find(t=>t.id===active)?.content}</div>
    </div>
  );
};

export const SegmentedControl: React.FC<{ options: { value:string; label:string }[]; value:string; onChange(v:string):void; ariaLabel:string }> = ({ options, value, onChange, ariaLabel }) => (
  <div role="radiogroup" aria-label={ariaLabel} className="inline-flex overflow-hidden rounded-md border border-border">
    {options.map(o => (
      <button key={o.value} role="radio" aria-checked={o.value===value} onClick={()=>onChange(o.value)} className={cn('px-3 py-1 text-sm font-medium', o.value===value ? 'bg-brand text-white' : 'bg-card hover:bg-brand/10')}>{o.label}</button>
    ))}
  </div>
);