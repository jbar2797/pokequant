"use client";
import { AppShell, SignalBadge, FactorBreakdown, TimeseriesChart, SegmentedControl, CardTile } from '../../../../../packages/ui';
import Image from 'next/image';
import React, { useEffect, useMemo, useState } from 'react';
import { computeVolatility, computeMaxDrawdown, computeLiquidity, formatNumber } from '../../../../../packages/ui/lib/analytics';
import { useAppState } from '../../state/store';

export default function CardDetail({ params }: { params:{ id:string } }) {
  const { toggleWatch, isWatched } = useAppState();
  const [card, setCard] = useState<any|null>(undefined);
  const [points, setPoints] = useState<any[]>([]);
  const [windowVal, setWindowVal] = useState('90d');
  const [showScore, setShowScore] = useState(true);
  useEffect(()=>{(async()=>{
    const r = await fetch(`/api/cards/${params.id}`); setCard(r.ok ? (await r.json()).card : null);
    const rs = await fetch(`/api/timeseries/${params.id}`); setPoints(rs.ok ? (await rs.json()).series || (await rs.json()).points || [] : []);
  })();},[params.id]);
  const filtered = useMemo(()=>{
    if(!points.length) return points;
    if(windowVal==='all') return points;
    const now = Date.now()/1000;
    const days = Number(windowVal.replace('d','').replace('y',''));
    const seconds = windowVal.includes('y')? days*365*86400 : days*86400;
    return points.filter(p=> p.t >= now - seconds);
  },[points, windowVal]);
  if (card === null) return <AppShell><p className="p-6">Not found.</p></AppShell>;
  if (card === undefined) return <AppShell><p className="p-6">Loading...</p></AppShell>;
  const volatility = computeVolatility(filtered);
  const mdd = computeMaxDrawdown(filtered);
  const liquidity = computeLiquidity(filtered);
  return <AppShell header={<div className="text-sm font-semibold">Card</div>} sidebar={<ul className="text-sm space-y-2"><li><a href="/">Dashboard</a></li><li><a href="/search">Search</a></li></ul>}>
    <article className="space-y-6">
      <header className="flex flex-col gap-4 md:flex-row">
        <div className="w-56 flex-shrink-0 relative aspect-[3/4]">
          <Image src={card.image} alt={card.name} fill priority sizes="224px" className="rounded-md border border-border bg-muted/10 object-contain" />
        </div>
        <div className="flex-1 space-y-2">
          <h1 className="text-xl font-semibold">{card.name}</h1>
          <p className="text-sm text-muted">{card.set} · {card.rarity}</p>
          <SignalBadge signal={card.signal} />
        </div>
      </header>
      <section aria-label="Price & Score Chart" className="space-y-2">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <h2 className="text-sm font-semibold">Price & Score</h2>
          <div className="flex items-center gap-4">
            <SegmentedControl ariaLabel="Window" value={windowVal} onChange={setWindowVal} options={[{value:'30d',label:'30D'},{value:'90d',label:'90D'},{value:'1y',label:'1Y'},{value:'all',label:'All'}]} />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={showScore} onChange={e=> setShowScore(e.target.checked)} />Score</label>
          </div>
        </div>
        <TimeseriesChart data={filtered} showScore={showScore} />
      </section>
      <section aria-label="Factor Breakdown" className="space-y-2">
        <h2 className="text-sm font-semibold">Factor Breakdown</h2>
        <FactorBreakdown factors={[{name:'Rarity',weight:0.4},{name:'Demand',weight:0.35},{name:'Supply',weight:0.25}]} />
      </section>
      <section aria-label="Signal History" className="space-y-2">
        <h2 className="text-sm font-semibold">Signal History</h2>
        <p className="text-xs text-muted">(Placeholder) Recent signal changes will appear here.</p>
      </section>
      <section aria-label="Volatility & Drawdown" className="space-y-2">
        <h2 className="text-sm font-semibold">Volatility & Drawdown</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6 text-xs">
          <div className="rounded border border-border p-2 flex flex-col gap-1"><span className="font-medium">Annual Vol</span><span>{formatNumber(volatility, { maximumFractionDigits:2 })}%</span></div>
          <div className="rounded border border-border p-2 flex flex-col gap-1"><span className="font-medium">Max Drawdown</span><span>{formatNumber(mdd, { maximumFractionDigits:2 })}%</span></div>
        </div>
      </section>
      <section aria-label="Liquidity" className="space-y-2">
        <h2 className="text-sm font-semibold">Liquidity</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6 text-xs">
          <div className="rounded border border-border p-2 flex flex-col gap-1"><span className="font-medium">Liquidity Index</span><span>{formatNumber(liquidity, { maximumFractionDigits:2 })}</span></div>
        </div>
        <p className="text-[10px] text-muted">Higher number indicates tighter pricing / higher stability (heuristic).</p>
      </section>
      <section aria-label="Comparable Cards" className="space-y-2">
        <h2 className="text-sm font-semibold">Comparable Cards</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{/* Placeholder comparables reuse CardTile minimal data */}
           <CardTile {...card} id={card.id+'-c1'} name={card.name+' Alt'} watchActive={isWatched(card.id+'-c1')} onWatchToggle={toggleWatch} />
           <CardTile {...card} id={card.id+'-c2'} name={card.name+' Promo'} watchActive={isWatched(card.id+'-c2')} onWatchToggle={toggleWatch} />
           <CardTile {...card} id={card.id+'-c3'} name={card.name+' 1st Ed.'} watchActive={isWatched(card.id+'-c3')} onWatchToggle={toggleWatch} />
           <CardTile {...card} id={card.id+'-c4'} name={card.name+' JP'} watchActive={isWatched(card.id+'-c4')} onWatchToggle={toggleWatch} />
        </div>
      </section>
    </article>
  </AppShell>;
}