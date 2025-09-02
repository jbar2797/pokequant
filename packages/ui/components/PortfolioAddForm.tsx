"use client";
import React, { useState } from 'react';
import { z } from 'zod';
import { InlineError, Button } from '../primitives';
import { useToast } from './Toast';

const schema = z.object({ card: z.string().min(1), qty: z.number().min(1), cost: z.number().min(0), acquired: z.string().min(1) });

export const PortfolioAddForm: React.FC<{ onAdd(h: { card:string; qty:number; cost:number; acquired:string }): void }> = ({ onAdd }) => {
  const { push } = useToast();
  const [errors, setErrors] = useState<Record<string,string>>({});
  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    const values = { card: String(fd.get('card')||''), qty: Number(fd.get('qty')), cost: Number(fd.get('cost')), acquired: String(fd.get('acquired')||'') };
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const map: Record<string,string> = {};
      parsed.error.issues.forEach(i=> { if (i.path[0]) map[i.path[0] as string] = i.message; });
      setErrors(map); return;
    }
    setErrors({});
  onAdd(parsed.data as { card:string; qty:number; cost:number; acquired:string });
    push({ title: 'Holding added' });
    (e.currentTarget as HTMLFormElement).reset();
  };
  return <form onSubmit={handle} className="space-y-3">
    <div>
  <label className="flex flex-col gap-1 text-xs font-medium">Card<input name="card" aria-describedby={errors.card? 'err-card':undefined} className="rounded border border-border px-2 py-1 text-sm" /></label>
  {errors.card && <InlineError id="err-card" message={errors.card} />}
    </div>
    <div className="flex gap-3">
  <div className="flex-1"><label className="flex flex-col gap-1 text-xs font-medium">Qty<input type="number" name="qty" aria-describedby={errors.qty? 'err-qty':undefined} className="rounded border border-border px-2 py-1 text-sm" /></label>{errors.qty && <InlineError id="err-qty" message={errors.qty} />}</div>
  <div className="flex-1"><label className="flex flex-col gap-1 text-xs font-medium">Cost<input type="number" step="0.01" name="cost" aria-describedby={errors.cost? 'err-cost':undefined} className="rounded border border-border px-2 py-1 text-sm" /></label>{errors.cost && <InlineError id="err-cost" message={errors.cost} />}</div>
    </div>
    <div>
  <label className="flex flex-col gap-1 text-xs font-medium">Acquired<input type="date" name="acquired" aria-describedby={errors.acquired? 'err-acquired':undefined} className="rounded border border-border px-2 py-1 text-sm" /></label>
  {errors.acquired && <InlineError id="err-acquired" message={errors.acquired} />}
    </div>
    <Button type="submit" className="w-full">Add Holding</Button>
  </form>;
};