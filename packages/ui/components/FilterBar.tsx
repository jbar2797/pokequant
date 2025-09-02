"use client";
import React, { useTransition } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';

function setParam(sp: URLSearchParams, key: string, value: string) {
  if (!value) sp.delete(key); else sp.set(key, value);
}

export const FilterBar: React.FC = () => {
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const [pending, start] = useTransition();
  const update = (k: string, v: string) => {
    const next = new URLSearchParams(sp.toString());
    setParam(next, k, v);
    start(()=>router.replace(`${path}?${next.toString()}`));
  };
  return (
    <form role="search" className="sticky top-12 z-30 flex flex-wrap gap-2 border-b border-border bg-card/95 p-3 backdrop-blur">
      <input aria-label="Search name" defaultValue={sp.get('query')||''} onChange={e=>update('query', e.target.value)} placeholder="Search name" className="w-40 rounded border border-border px-2 py-1 text-sm" />
      <input aria-label="Set" defaultValue={sp.get('set')||''} onChange={e=>update('set', e.target.value)} placeholder="Set" className="w-32 rounded border border-border px-2 py-1 text-sm" />
      <input aria-label="Rarity" defaultValue={sp.get('rarity')||''} onChange={e=>update('rarity', e.target.value)} placeholder="Rarity" className="w-32 rounded border border-border px-2 py-1 text-sm" />
      <select aria-label="Signal" defaultValue={sp.get('signal')||''} onChange={e=>update('signal', e.target.value)} className="rounded border border-border px-2 py-1 text-sm">
        <option value="">Signal</option>
        <option value="buy">Buy</option>
        <option value="hold">Hold</option>
        <option value="sell">Sell</option>
      </select>
      {pending && <span aria-live="polite" className="text-xs">Loading…</span>}
    </form>
  );
};