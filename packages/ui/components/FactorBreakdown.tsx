import React from 'react';

export interface Factor { name: string; weight: number; description?: string }
export const FactorBreakdown: React.FC<{ factors: Factor[] }> = ({ factors }) => {
  const total = factors.reduce((a,f)=>a+f.weight,0) || 1;
  return (
    <div className="space-y-2">
      {factors.map(f => (
        <div key={f.name} className="space-y-1">
          <div className="flex items-center justify-between text-xs font-medium"><span>{f.name}</span><span>{((f.weight/total)*100).toFixed(1)}%</span></div>
          <div className="h-2 w-full overflow-hidden rounded bg-muted/20">
            <div className="h-full bg-accent" style={{ width: `${(f.weight/total)*100}%` }} aria-hidden />
          </div>
        </div>
      ))}
      {factors.length===0 && <p className="text-xs text-muted">No factors available.</p>}
    </div>
  );
};