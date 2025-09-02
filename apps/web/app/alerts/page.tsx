"use client";
import { AppShell, Button, AlertRuleForm, useToast } from '../../../../packages/ui';
import { useAppState } from '../state/store';
import React from 'react';

export default function AlertsPage() {
  const { addAlert, alerts, removeAlert } = useAppState();
  const { push } = useToast();
  return <AppShell header={<div className="text-sm font-semibold">Alerts</div>} sidebar={<ul className="text-sm space-y-2"><li><a href="/">Dashboard</a></li><li><a href="/alerts" className="font-semibold">Alerts</a></li></ul>}>
    <h1 className="text-lg font-semibold mb-4">Alerts</h1>
    <p className="text-sm text-muted mb-4">Create rules for signal changes and price thresholds.</p>
    <div className="max-w-md mb-8">
      <AlertRuleForm onCreate={(rule)=>{ addAlert(rule); }} />
    </div>
    <h2 className="text-sm font-semibold mb-2">Existing Rules</h2>
    {alerts.length===0 && <p className="text-xs text-muted">No alerts yet.</p>}
    <ul className="space-y-2">
      {alerts.map(a=> <li key={a.id} className="flex items-center justify-between rounded border border-border px-3 py-2 text-xs">
        <span>{a.type}{' '}{('price' in a && (a as any).price)?`@ ${(a as any).price}`:''}{('pct' in a && (a as any).pct)?` ${ (a as any).pct }%/${(a as any).window}d`:''}</span>
  <Button size="sm" variant="ghost" onClick={()=> { removeAlert(a.id); push({ title:'Alert deleted', actionLabel:'Undo', onAction: ()=> addAlert(a as any) }); }}>Delete</Button>
      </li>)}
    </ul>
  </AppShell>;
}