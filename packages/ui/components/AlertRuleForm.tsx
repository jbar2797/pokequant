"use client";
import React, { useState } from 'react';
import { z } from 'zod';
import { InlineError, Button } from '../primitives';
import { useToast } from './Toast';

const base = { card: z.string().min(1), webhook: z.string().url().optional() };
const ruleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('signal-change'), card: base.card, webhook: base.webhook }),
  z.object({ type: z.literal('price-above'), card: base.card, price: z.number().min(0), webhook: base.webhook }),
  z.object({ type: z.literal('price-below'), card: base.card, price: z.number().min(0), webhook: base.webhook }),
  z.object({ type: z.literal('pct-move'), card: base.card, pct: z.number().min(0.01), window: z.number().min(1), webhook: base.webhook })
]);

export const AlertRuleForm: React.FC<{ onCreate(rule:any):void }> = ({ onCreate }) => {
  const { push } = useToast();
  const [type, setType] = useState('signal-change');
  const [errors, setErrors] = useState<Record<string,string>>({});
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    const raw: any = { type, card: fd.get('card'), webhook: fd.get('webhook')||undefined };
    if (type === 'price-above' || type === 'price-below') raw.price = Number(fd.get('price'));
    if (type === 'pct-move') { raw.pct = Number(fd.get('pct')); raw.window = Number(fd.get('window')); }
    const parsed = ruleSchema.safeParse(raw);
    if (!parsed.success) { const map: Record<string,string>={}; parsed.error.issues.forEach(i=>{if(i.path[0]) map[i.path[0] as string]=i.message;}); setErrors(map); return; }
    setErrors({});
    onCreate(parsed.data);
    push({ title: 'Alert created' });
    (e.currentTarget as HTMLFormElement).reset();
  };
  return <form onSubmit={submit} className="space-y-3">
    <div className="flex flex-col gap-1 text-xs font-medium">
      <label>Type<select value={type} onChange={e=>setType(e.target.value)} className="mt-1 rounded border border-border px-2 py-1 text-sm"><option value="signal-change">Signal Change</option><option value="price-above">Price Above</option><option value="price-below">Price Below</option><option value="pct-move">% Move</option></select></label>
    </div>
    <div>
  <label className="flex flex-col gap-1 text-xs font-medium">Card<input name="card" aria-describedby={errors.card? 'err-card-alert':undefined} className="rounded border border-border px-2 py-1 text-sm" /></label>
  {errors.card && <InlineError id="err-card-alert" message={errors.card} />}
    </div>
  {(type==='price-above'||type==='price-below') && <div><label className="flex flex-col gap-1 text-xs font-medium">Price<input name="price" type="number" step="0.01" aria-describedby={errors.price? 'err-price':undefined} className="rounded border border-border px-2 py-1 text-sm" /></label>{errors.price && <InlineError id="err-price" message={errors.price} />}</div>}
  {type==='pct-move' && <div className="flex gap-3"> <div className="flex-1"><label className="flex flex-col gap-1 text-xs font-medium">% Move<input name="pct" type="number" step="0.01" aria-describedby={errors.pct? 'err-pct':undefined} className="rounded border border-border px-2 py-1 text-sm" /></label>{errors.pct && <InlineError id="err-pct" message={errors.pct} />}</div><div className="flex-1"><label className="flex flex-col gap-1 text-xs font-medium">Window (d)<input name="window" type="number" aria-describedby={errors.window? 'err-window':undefined} className="rounded border border-border px-2 py-1 text-sm" /></label>{errors.window && <InlineError id="err-window" message={errors.window} />}</div></div>}
    <div className="space-y-1">
  <label className="flex flex-col gap-1 text-xs font-medium">Discord Webhook URL<input name="webhook" aria-describedby={errors.webhook? 'err-webhook':undefined} className="rounded border border-border px-2 py-1 text-sm" placeholder="https://discord.com/api/webhooks/..." /></label>
      <div className="flex items-center gap-2">
        <button type="button" onClick={async (e)=>{
          const form = (e.currentTarget.closest('form')) as HTMLFormElement;
          const url = (new FormData(form)).get('webhook') as string;
          if(!url) { push({ title:'Enter webhook URL first'}); return; }
          try { await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ content:'Test alert from PokeQuant'})}); push({ title:'Webhook test sent'}); }
          catch { push({ title:'Webhook test failed'}); }
        }} className="text-[11px] rounded border border-border px-2 py-1 hover:bg-muted/20">Test</button>
        <p className="text-[11px] text-muted">Sends a simple test message.</p>
      </div>
  {errors.webhook && <InlineError id="err-webhook" message={errors.webhook} />}
    </div>
    <Button type="submit" className="w-full">Create Alert</Button>
  </form>;
};