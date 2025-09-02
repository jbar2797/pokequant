import React from 'react';

export const Sparkline: React.FC<{ values: number[]; stroke?: string; width?: number; height?: number; label?: string }> = ({ values, stroke='hsl(var(--brand))', width=80, height=24, label }) => {
  if (!values.length) return <div aria-label={label||'Empty sparkline'} className="h-6 w-20" />;
  const min = Math.min(...values); const max = Math.max(...values);
  const norm = values.map(v => (max===min? 0.5 : (v-min)/(max-min)));
  const d = norm.map((v,i)=> `${i===0?'M':'L'} ${(i/(values.length-1))*width} ${(1-v)*height}`).join(' ');
  return (
    <svg role="img" aria-label={label||'Trend'} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <path d={d} fill="none" stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
};