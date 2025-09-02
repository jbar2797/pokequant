"use client";
import React, { useEffect, useRef } from 'react';
import { Skeleton } from './Feedback';

export interface TimeseriesPoint { t: number; price: number; score?: number }
export interface TimeseriesChartProps { data: TimeseriesPoint[]; height?: number; reducedMotion?: boolean; showScore?: boolean }

export const TimeseriesChart: React.FC<TimeseriesChartProps> = ({ data, height=240, reducedMotion, showScore=true }) => {
  const ref = useRef<HTMLDivElement|null>(null);
  useEffect(()=>{
    if (reducedMotion) return; // fallback table below
    let chart: any; let areaSeries: any; let scoreSeries: any; let disposed=false;
    (async () => {
      const { createChart } = await import('lightweight-charts');
      if (!ref.current) return;
      chart = createChart(ref.current, { height, layout: { background: { color: 'transparent' }, textColor: 'hsl(var(--fg))' }, grid: { vertLines: { color: 'transparent' }, horzLines: { color: 'transparent' } } });
      areaSeries = chart.addAreaSeries({ lineColor: 'hsl(var(--accent))', topColor: 'hsl(var(--accent) / 0.3)', bottomColor: 'hsl(var(--accent) / 0.05)' });
      areaSeries.setData(data.map(p => ({ time: p.t as any, value: p.price })));
  if (showScore && data.some(p=>p.score!=null)) {
        scoreSeries = chart.addLineSeries({ color: 'hsl(var(--brand))' });
        scoreSeries.setData(data.filter(p=>p.score!=null).map(p=>({ time: p.t as any, value: p.score! })));
      }
      const ro = new ResizeObserver(()=>chart.applyOptions({ width: ref.current?.clientWidth }));
      if (ref.current) ro.observe(ref.current);
    })();
    return () => { disposed=true; try { chart?.remove(); } catch { /* noop */ } };
  }, [data, height, reducedMotion, showScore]);

  if (!data.length) return <Skeleton className="w-full" lines={4} />;

  if (reducedMotion) {
    return <table className="w-full text-xs"><thead><tr><th className="text-left">Time</th><th className="text-left">Price</th>{data.some(p=>p.score!=null)&&<th className="text-left">Score</th>}</tr></thead><tbody>{data.slice(-30).map(p=> <tr key={p.t}><td>{new Date(p.t*1000).toLocaleDateString()}</td><td>{p.price.toFixed(2)}</td>{p.score!=null && <td>{p.score.toFixed(2)}</td>}</tr>)}</tbody></table>;
  }
  const prices = data.map(d=>d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const latest = prices[prices.length-1];
  return <div className="w-full space-y-1">
    <div aria-label="Timeseries chart" className="w-full" style={{ height }} ref={ref} />
    <p className="sr-only" aria-live="polite">Price range {min.toFixed(2)} to {max.toFixed(2)}. Latest {latest.toFixed(2)}.</p>
  </div>;
};