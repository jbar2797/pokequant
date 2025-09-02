import { Suspense } from 'react';
import { FilterBar, CardTile, AppShell } from '../../../../packages/ui';

async function getCards(searchParams: Record<string,string|undefined>) {
  const qp = new URLSearchParams();
  for (const k of ['query','set','rarity','signal']) if (searchParams[k]) qp.set(k, searchParams[k]!);
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || ''}/api/cards?${qp.toString()}`, { cache: 'no-store' });
  if (!res.ok) return [];
  const json = await res.json();
  return json.cards as any[];
}

export default async function SearchPage({ searchParams }: { searchParams: Record<string,string|undefined> }) {
  const cards = await getCards(searchParams);
  return <AppShell header={<div className="text-sm font-semibold">Search</div>} sidebar={<ul className="text-sm space-y-2"><li>Dashboard</li><li className="font-semibold">Search</li><li>Portfolio</li></ul>}>
    <FilterBar />
    <section className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {cards.length === 0 && <p className="col-span-full text-sm text-muted">No results. Try another query.</p>}
      {cards.map(c => <CardTile key={c.id} {...c} />)}
    </section>
  </AppShell>;
}