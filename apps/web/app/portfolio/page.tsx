"use client";
import { AppShell, DataTable, MetricCard, PortfolioAddForm, Button, useToast } from '../../../../packages/ui';
import React, { useMemo } from 'react';
import { useAppState } from '../state/store';

interface Holding { id:string; card:string; qty:number; cost:number; market:number; }

export default function PortfolioPage() {
  const { portfolio, addHolding, removeHolding } = useAppState();
  const { push } = useToast();
  const derivedHoldings: Holding[] = portfolio.map(h=>({ id:h.id, card:h.name, qty:h.quantity, cost:h.basis, market: h.basis*1.25 }));
  const { totalCost, totalMarket, pnl } = useMemo(()=>{
    const totalCost = derivedHoldings.reduce((a,h)=>a+h.cost,0);
    const totalMarket = derivedHoldings.reduce((a,h)=>a+h.market,0);
    return { totalCost, totalMarket, pnl: totalCost>0 ? (totalMarket-totalCost)/totalCost : 0 };
  }, [derivedHoldings]);
  const columns = useMemo(()=>[
    { header: 'Card', accessorKey: 'card' },
    { header: 'Qty', accessorKey: 'qty' },
    { header: 'Cost Basis', cell: ({ row }: any)=> `$${row.original.cost.toFixed(2)}` },
    { header: 'Market Value', cell: ({ row }: any)=> `$${row.original.market.toFixed(2)}` },
    { header: 'P&L %', cell: ({ row }: any)=> `${row.original.cost>0?(((row.original.market-row.original.cost)/row.original.cost)*100).toFixed(1):'0.0'}%` },
    { header: 'Actions', cell: ({ row }: any)=> <Button size="sm" variant="ghost" onClick={()=> {
      const removed = row.original;
      removeHolding(row.original.id);
      push({ title: 'Holding removed', actionLabel: 'Undo', onAction: ()=> addHolding({ name: removed.card, quantity: removed.qty, basis: removed.cost }) });
    }}>Remove</Button> }
  ], [removeHolding]);
  return <AppShell header={<div className="text-sm font-semibold">Portfolio</div>} sidebar={<ul className="text-sm space-y-2"><li><a href="/">Dashboard</a></li><li><a href="/portfolio" className="font-semibold">Portfolio</a></li></ul>}>
    <div className="grid gap-3 md:grid-cols-3 mb-6">
      <MetricCard label='Total Value' value={`$${totalMarket.toFixed(2)}`} delta={pnl} />
      <MetricCard label='Cost Basis' value={`$${totalCost.toFixed(2)}`} />
      <MetricCard label='P&L %' value={`${(pnl*100).toFixed(2)}%`} delta={pnl} />
    </div>
    <details className="mb-4 rounded border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold">Add Holding</summary>
      <div className="mt-3 max-w-sm">
  <PortfolioAddForm onAdd={(data)=>{ addHolding({ name: data.card, quantity: data.qty, basis: data.cost }); }} />
      </div>
    </details>
  <DataTable data={derivedHoldings} columns={columns as any} caption="Portfolio holdings" />
  </AppShell>;
}