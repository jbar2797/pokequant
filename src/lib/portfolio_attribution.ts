import type { Env } from './types';

// Portfolio performance attribution: prior-day factor exposures * factor_returns vs NAV return.
export async function computePortfolioAttribution(env: Env, portfolioId: string, days: number) {
  const look = Math.min(180, Math.max(1, days));
  const navRs = await env.DB.prepare(`SELECT as_of, market_value FROM portfolio_nav WHERE portfolio_id=? ORDER BY as_of ASC`).bind(portfolioId).all();
  const navRows = (navRs.results||[]) as any[];
  if (navRows.length < 2) return [];
  const navMap = new Map<string, number>();
  for (const r of navRows) navMap.set(String(r.as_of), Number(r.market_value)||0);
  const exposuresRs = await env.DB.prepare(`SELECT as_of, factor, exposure FROM portfolio_factor_exposure WHERE portfolio_id=? AND as_of >= date('now', ? )`).bind(portfolioId, `-${look} day`).all();
  const factRetRs = await env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns WHERE as_of >= date('now', ? )`).bind(`-${look} day`).all();
  const exposuresByDay: Record<string, Record<string, number>> = {};
  for (const r of (exposuresRs.results||[]) as any[]) { const d=String(r.as_of); const f=String(r.factor); const v=Number(r.exposure); if(!Number.isFinite(v)) continue; (exposuresByDay[d] ||= {})[f]=v; }
  const factorRetByDay: Record<string, Record<string, number>> = {};
  for (const r of (factRetRs.results||[]) as any[]) { const d=String(r.as_of); const f=String(r.factor); const v=Number(r.ret); if(!Number.isFinite(v)) continue; (factorRetByDay[d] ||= {})[f]=v; }
  const dates = Array.from(navMap.keys()).sort();
  const out: any[] = [];
  for (let i=0;i<dates.length-1;i++) {
    const d=dates[i]; const nd=dates[i+1]; const nav0=navMap.get(d)!; const nav1=navMap.get(nd)!; if(!(nav0>0&&nav1>0)) continue;
    const portRet=(nav1-nav0)/nav0; const ex=exposuresByDay[d]; const fr=factorRetByDay[d]; if(!ex||!fr) continue;
    let sum=0; const contrib: Record<string,number>={};
    for (const [f,e] of Object.entries(ex)) { const r = fr[f]; if(!Number.isFinite(r)) continue; const c=e*r; contrib[f]=+c.toFixed(6); sum+=c; }
    const residual=portRet-sum;
    out.push({ as_of:d, to:nd, portfolio_return:+portRet.toFixed(6), factor_contrib_sum:+sum.toFixed(6), residual:+residual.toFixed(6), contributions: contrib });
  }
  return out.slice(-look);
}
