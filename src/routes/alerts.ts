import { router } from '../router';
import { json, err } from '../lib/http';
import { audit } from '../lib/audit';
import { incMetric } from '../lib/metrics';
import { getRateLimits, rateLimit } from '../lib/rate_limit';
import type { Env } from '../lib/types';
import { ensureAlertsTable, getAlertThresholdCol, ensureTestSeed } from '../lib/data';

export function registerAlertRoutes(){
  router
    .add('POST','/alerts/create', async ({ env, req, url }) => {
      // Ensure core + audit tables so audit(create) doesn't fail silently
      await ensureTestSeed(env);
      await ensureAlertsTable(env);
      const ip = req.headers.get('cf-connecting-ip') || 'anon';
      const body: any = await req.json().catch(()=>({}));
      const email = body && body.email ? String(body.email).trim() : '';
      const card_id = body && body.card_id ? String(body.card_id).trim() : '';
      const kind = body && body.kind ? String(body.kind).trim() : 'price_below';
      const threshold = body && body.threshold !== undefined ? Number(body.threshold) : NaN;
      const snoozeMinutes = Number(body.snooze_minutes);
      if (!email || !card_id) return err('email_and_card_id_required');
      if (!Number.isFinite(threshold)) return err('threshold_invalid');
      const rlKey = `alert:${ip}:${email}`;
      const cfg = getRateLimits(env).alertCreate;
      const rl = await rateLimit(env, rlKey, cfg.limit, cfg.window);
      if (!rl.allowed) { await incMetric(env, 'rate_limited.alert_create'); return json({ ok:false, error:'rate_limited', retry_after: rl.reset - Math.floor(Date.now()/1000) }, 429); }
      const id = crypto.randomUUID();
      const tokenBytes = new Uint8Array(16); crypto.getRandomValues(tokenBytes);
      const manage_token = Array.from(tokenBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
      const col = await getAlertThresholdCol(env);
      await env.DB.prepare(
        `INSERT INTO alerts_watch (id,email,card_id,kind,${col},active,manage_token,created_at,suppressed_until) VALUES (?,?,?,?,?,1,?,datetime('now'), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ? || ' minutes') END)`
      ).bind(id, email, card_id, kind, threshold, manage_token, Number.isFinite(snoozeMinutes)?1:null, Number.isFinite(snoozeMinutes)?snoozeMinutes.toString():null).run();
      const manage_url = `${env.PUBLIC_BASE_URL || ''}/alerts/deactivate?id=${encodeURIComponent(id)}&token=${encodeURIComponent(manage_token)}`;
      await incMetric(env, 'alert.created');
      await audit(env, { actor_type:'public', action:'create', resource:'alert', resource_id:id, details:{ card_id, kind, threshold } });
      const meta = await env.DB.prepare(`SELECT suppressed_until, fired_count FROM alerts_watch WHERE id=?`).bind(id).all();
      const row: any = meta.results?.[0] || {};
      return json({ ok: true, id, manage_token, manage_url, suppressed_until: row.suppressed_until || null, fired_count: row.fired_count || 0 });
    })
    .add('POST','/alerts/snooze', async ({ env, req, url }) => {
      await ensureTestSeed(env);
      await ensureAlertsTable(env);
      const id = url.searchParams.get('id') || '';
      const body: any = await req.json().catch(()=>({}));
      const minutes = Number(body.minutes);
      const token = (body.token||'').toString();
      if (!id || !Number.isFinite(minutes)) return err('id_and_minutes_required');
      const row = await env.DB.prepare(`SELECT manage_token FROM alerts_watch WHERE id=?`).bind(id).all();
      const found = (row.results||[])[0] as any;
      if (!found) return err('not_found',404);
      if (found.manage_token !== token) return err('forbidden',403);
      await env.DB.prepare(`UPDATE alerts_watch SET suppressed_until=datetime('now', ? || ' minutes') WHERE id=?`).bind(minutes.toString(), id).run();
      await audit(env, { actor_type:'public', action:'snooze', resource:'alert', resource_id:id, details:{ minutes } });
      return json({ ok:true, id, suppressed_for_minutes: minutes });
    });
}

registerAlertRoutes();
