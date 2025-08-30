import type { Env } from './types';
import { log } from './log';

export async function updateDataCompleteness(env: Env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS data_completeness (dataset TEXT, as_of DATE, rows INTEGER, PRIMARY KEY(dataset,as_of));`).run();
    const today = new Date().toISOString().slice(0,10);
    const datasets: [string,string][] = [
      ['prices_daily','SELECT COUNT(*) AS n FROM prices_daily WHERE as_of=?'],
      ['signals_daily','SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=?'],
      ['svi_daily','SELECT COUNT(*) AS n FROM svi_daily WHERE as_of=?'],
      ['signal_components_daily','SELECT COUNT(*) AS n FROM signal_components_daily WHERE as_of=?']
    ];
    for (const [ds, sql] of datasets) {
      const r = await env.DB.prepare(sql).bind(today).all();
      const n = Number(r.results?.[0]?.n)||0;
      await env.DB.prepare(`INSERT OR REPLACE INTO data_completeness (dataset, as_of, rows) VALUES (?,?,?)`).bind(ds, today, n).run();
    }
  } catch (e) {
    log('data_completeness_update_error', { error: String(e) });
  }
}

export async function computeIntegritySnapshot(env: Env) {
  try {
    const [cards, lp, ls, lsv, lc, cp, cs, csv, cc] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all(),
      env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all(),
      env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all(),
      env.DB.prepare(`SELECT MAX(as_of) AS d FROM svi_daily`).all(),
      env.DB.prepare(`SELECT MAX(as_of) AS d FROM signal_components_daily`).all(),
      env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM prices_daily WHERE as_of=(SELECT MAX(as_of) FROM prices_daily)`).all(),
      env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM signals_daily WHERE as_of=(SELECT MAX(as_of) FROM signals_daily)`).all(),
      env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM svi_daily WHERE as_of=(SELECT MAX(as_of) FROM svi_daily)`).all(),
      env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM signal_components_daily WHERE as_of=(SELECT MAX(as_of) FROM signal_components_daily)`).all()
    ]);
    const today = new Date().toISOString().slice(0,10);
    const windowDays = 30;
    const gapQuery = async (table: string) => {
      try {
        const res = await env.DB.prepare(`SELECT MIN(as_of) AS min_d, COUNT(DISTINCT as_of) AS days FROM ${table} WHERE as_of >= date('now','-${windowDays-1} day')`).all();
        const row: any = res.results?.[0] || {};
        const minD = row.min_d as string | null;
        const distinct = Number(row.days)||0;
        let expected = windowDays;
        if (minD) {
          const ms = (Date.parse(today) - Date.parse(minD));
          if (Number.isFinite(ms)) {
            const spanDays = Math.floor(ms/86400000)+1;
            if (spanDays < expected) expected = spanDays;
          }
        }
        return Math.max(0, expected - distinct);
      } catch { return 0; }
    };
    const [gp, gs, gsv, gcc] = await Promise.all([
      gapQuery('prices_daily'), gapQuery('signals_daily'), gapQuery('svi_daily'), gapQuery('signal_components_daily')
    ]);
    const latest = {
      prices_daily: lp.results?.[0]?.d || null,
      signals_daily: ls.results?.[0]?.d || null,
      svi_daily: lsv.results?.[0]?.d || null,
      signal_components_daily: lc.results?.[0]?.d || null
    } as Record<string,string|null>;
    const stale: string[] = [];
    const staleThresholdDays = 2;
    for (const [k,v] of Object.entries(latest)) {
      if (v) {
        const age = Math.floor((Date.parse(today) - Date.parse(v))/86400000);
        if (age > staleThresholdDays) stale.push(k);
      }
    }
    let completeness: any[] = [];
    try {
      const crs = await env.DB.prepare(`SELECT dataset, as_of, rows FROM data_completeness WHERE as_of >= date('now','-13 day') ORDER BY as_of DESC, dataset`).all();
      completeness = crs.results || [];
    } catch { /* ignore */ }
    return {
      ok: true,
      total_cards: cards.results?.[0]?.n ?? 0,
      latest,
      coverage_latest: {
        prices_daily: cp.results?.[0]?.n ?? 0,
        signals_daily: cs.results?.[0]?.n ?? 0,
        svi_daily: csv.results?.[0]?.n ?? 0,
        signal_components_daily: cc.results?.[0]?.n ?? 0
      },
      gaps_last_30: { prices_daily: gp, signals_daily: gs, svi_daily: gsv, signal_components_daily: gcc },
      stale,
      completeness
    };
  } catch (e:any) {
    return { ok:false, error:String(e) };
  }
}
