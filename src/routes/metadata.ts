import { router } from '../router';
import { json } from '../lib/http';
import { incMetric, recordLatency } from '../lib/metrics';
import type { Env } from '../lib/types';
import { ensureTestSeed } from '../lib/data';
import { baseDataSignature } from '../lib/base_data';

// External helpers
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const CORS: Record<string,string>;

export function registerMetadataRoutes(){
  router
    .add('GET','/api/sets', async ({ env, req }) => {
      const t0 = Date.now();
      await ensureTestSeed(env);
      const sig = await baseDataSignature(env);
      const etag = `"${sig}:sets"`;
      if (req.headers.get('if-none-match') === etag) {
        await incMetric(env, 'cache.hit.sets');
        const resp304 = new Response(null, { status:304, headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=300', ...CORS } });
        await recordLatency(env, 'lat.sets', Date.now()-t0);
        return resp304;
      }
      const rs = await env.DB.prepare(`SELECT set_name AS v, COUNT(*) AS n FROM cards GROUP BY set_name ORDER BY n DESC`).all();
      const resp = json(rs.results || []);
      resp.headers.set('Cache-Control', 'public, max-age=300');
      resp.headers.set('ETag', etag);
      await recordLatency(env, 'lat.sets', Date.now()-t0);
      return resp;
    })
    .add('GET','/api/rarities', async ({ env, req }) => {
      const t0 = Date.now();
      await ensureTestSeed(env);
      const sig = await baseDataSignature(env);
      const etag = `"${sig}:rarities"`;
      if (req.headers.get('if-none-match') === etag) {
        await incMetric(env, 'cache.hit.rarities');
        const resp304 = new Response(null, { status:304, headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=300', ...CORS } });
        await recordLatency(env, 'lat.rarities', Date.now()-t0);
        return resp304;
      }
      const rs = await env.DB.prepare(`SELECT rarity AS v, COUNT(*) AS n FROM cards GROUP BY rarity ORDER BY n DESC`).all();
      const resp = json(rs.results || []);
      resp.headers.set('Cache-Control', 'public, max-age=300');
      resp.headers.set('ETag', etag);
      await recordLatency(env, 'lat.rarities', Date.now()-t0);
      return resp;
    })
    .add('GET','/api/types', async ({ env, req }) => {
      const t0 = Date.now();
      await ensureTestSeed(env);
      const sig = await baseDataSignature(env);
      const etag = `"${sig}:types"`;
      if (req.headers.get('if-none-match') === etag) {
        await incMetric(env, 'cache.hit.types');
        const resp304 = new Response(null, { status:304, headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=300', ...CORS } });
        await recordLatency(env, 'lat.types', Date.now()-t0);
        return resp304;
      }
      const rs = await env.DB.prepare(`SELECT DISTINCT types FROM cards WHERE types IS NOT NULL`).all();
      const out: { v: string }[] = [];
      for (const r of (rs.results||[]) as any[]) {
        const parts = String(r.types||'').split('|').filter(Boolean);
        for (const p of parts) out.push({ v: p });
      }
      const resp = json(out);
      resp.headers.set('Cache-Control', 'public, max-age=300');
      resp.headers.set('ETag', etag);
      await recordLatency(env, 'lat.types', Date.now()-t0);
      return resp;
    });
}

registerMetadataRoutes();
