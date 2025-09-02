"use client";
import { AppShell, CardTile } from '../../../../packages/ui';
import React, { useEffect, useState } from 'react';
import { useAppState } from '../state/store';

export default function WatchlistPage() {
  const { watchlist, toggleWatch, isWatched } = useAppState();
  const [cards, setCards] = useState<any[]>([]);
  useEffect(()=>{
    if (!watchlist.length) { setCards([]); return; }
    Promise.all(watchlist.map(async id => {
      const r = await fetch(`/api/cards/${id}`);
      if (!r.ok) return null; return (await r.json()).card;
    })).then(list => setCards(list.filter(Boolean)));
  }, [watchlist]);
  return <AppShell header={<div className="text-sm font-semibold">Watchlist</div>} sidebar={<ul className="text-sm space-y-2"><li><a href="/">Dashboard</a></li><li><a href="/watchlist" className="font-semibold">Watchlist</a></li></ul>}>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
      {cards.map(c=> <CardTile key={c.id} {...c} watchActive={isWatched(c.id)} onWatchToggle={toggleWatch} />)}
      {cards.length===0 && <p className="col-span-full text-sm text-muted">No watchlist items.</p>}
    </div>
  </AppShell>;
}