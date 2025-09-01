import { router } from '../router';
import { json, err } from '../lib/http';
import { ErrorCodes } from '../lib/errors';
import { audit } from '../lib/audit';
import { incMetric } from '../lib/metrics';
import { getRateLimits, rateLimit } from '../lib/rate_limit';
import type { Env } from '../lib/types';
import { ensureAlertsTable, getAlertThresholdCol, ensureTestSeed } from '../lib/data';
import { AlertCreateSchema, validate } from '../lib/validation';

export function registerAlertRoutes(){
  router
    .add('POST','/alerts/create', async ({ env, req, url }) => {
      // Parse & validate first so missing-field errors short-circuit before any table work (reduces chance of runtime I/O issues under heavy parallel tests)
      const ip = req.headers.get('cf-connecting-ip') || 'anon';
      const body: any = await req.json().catch(()=>({}));
      const parsed = validate(AlertCreateSchema, body);
      if (!parsed.ok) {
        const hasEmail = typeof body.email === 'string' && body.email.length > 0;
        const hasCard = typeof body.card_id === 'string' && body.card_id.length > 0;
        if (!hasEmail || !hasCard) return err(ErrorCodes.EmailAndCardIdRequired, 400);
        if (body.threshold === undefined || body.threshold === null || Number.isNaN(Number(body.threshold))) {
          return err(ErrorCodes.ThresholdInvalid, 400);
        }
        return err(ErrorCodes.InvalidBody, 400, { details: parsed.errors });
      }
      // Only ensure schema after validation passes
      await ensureTestSeed(env);
      await ensureAlertsTable(env);
      const { email, card_id, kind, threshold, snooze_minutes } = parsed.data;
      const snoozeMinutes = snooze_minutes == null ? undefined : snooze_minutes;
      const rlKey = `alert:${ip}:${email}`;
      const cfg = getRateLimits(env).alertCreate;
      const rl = await rateLimit(env, rlKey, cfg.limit, cfg.window);
      if (!rl.allowed) { await incMetric(env, 'rate_limited.alert_create'); return err(ErrorCodes.RateLimited, 429, { retry_after: rl.reset - Math.floor(Date.now()/1000) }); }
      const id = crypto.randomUUID();
      const tokenBytes = new Uint8Array(16); crypto.getRandomValues(tokenBytes);
      const manage_token = Array.from(tokenBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
      const col = await getAlertThresholdCol(env);
      await env.DB.prepare(
        `INSERT INTO alerts_watch (id,email,card_id,kind,${col},active,manage_token,created_at,suppressed_until) VALUES (?,?,?,?,?,1,?,datetime('now'), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ? || ' minutes') END)`
      ).bind(
        id,
        email,
        card_id,
        kind,
        threshold,
        manage_token,
        (typeof snoozeMinutes === 'number' && Number.isFinite(snoozeMinutes)) ? 1 : null,
        (typeof snoozeMinutes === 'number' && Number.isFinite(snoozeMinutes)) ? snoozeMinutes.toString() : null
      ).run();
      const manage_url = `${env.PUBLIC_BASE_URL || ''}/alerts/deactivate?id=${encodeURIComponent(id)}&token=${encodeURIComponent(manage_token)}`;
      await incMetric(env, 'alert.created');
      await audit(env, { actor_type:'public', action:'create', resource:'alert', resource_id:id, details:{ card_id, kind, threshold } });
      const meta = await env.DB.prepare(`SELECT suppressed_until, fired_count FROM alerts_watch WHERE id=?`).bind(id).all();
      const row: any = meta.results?.[0] || {};
      return json({ ok: true, id, manage_token, manage_url, suppressed_until: row.suppressed_until || null, fired_count: row.fired_count || 0 });
    })
    .add('GET','/alerts/deactivate', async ({ env, req, url }) => {
      const id = (url.searchParams.get('id') || '').trim();
      const token = (url.searchParams.get('token') || '').trim();
  if (!id || !token) return err(ErrorCodes.IdAndTokenRequired);
      const row = await env.DB.prepare(`SELECT manage_token FROM alerts_watch WHERE id=?`).bind(id).all();
  const mt = row.results?.[0]?.manage_token as string | undefined; if (!mt || mt !== token) return err(ErrorCodes.InvalidToken, 403);
      await env.DB.prepare(`UPDATE alerts_watch SET active=0 WHERE id=?`).bind(id).run();
      const html = `<!doctype html><meta charset="utf-8"><title>PokeQuant</title><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; padding:24px"><h3>Alert deactivated.</h3><p><a href="${env.PUBLIC_BASE_URL || '/'}">Back to PokeQuant</a></p></body>`;
      return new Response(html, { headers: { 'content-type':'text/html; charset=utf-8' } });
    })
    .add('POST','/alerts/deactivate', async ({ env, req }) => {
      // Body-based deactivate for test convenience
      const body:any = await req.json().catch(()=>({}));
      const id = (body.id||'').toString();
      const token = (body.token||'').toString();
  if (!id || !token) return err(ErrorCodes.IdAndTokenRequired);
      const row = await env.DB.prepare(`SELECT manage_token FROM alerts_watch WHERE id=?`).bind(id).all();
  const mt = row.results?.[0]?.manage_token as string | undefined; if (!mt || mt !== token) return err(ErrorCodes.InvalidToken, 403);
      await env.DB.prepare(`UPDATE alerts_watch SET active=0 WHERE id=?`).bind(id).run();
      await audit(env, { actor_type:'public', action:'deactivate', resource:'alert', resource_id:id, details:{} });
      return json({ ok:true, id, deactivated:true });
    })
    .add('POST','/alerts/snooze', async ({ env, req, url }) => {
      await ensureTestSeed(env);
      await ensureAlertsTable(env);
      const id = url.searchParams.get('id') || '';
      const body: any = await req.json().catch(()=>({}));
      const minutes = Number(body.minutes);
      const token = (body.token||'').toString();
  if (!id || !Number.isFinite(minutes)) return err(ErrorCodes.IdAndMinutesRequired);
      const row = await env.DB.prepare(`SELECT manage_token FROM alerts_watch WHERE id=?`).bind(id).all();
      const found = (row.results||[])[0] as any;
  if (!found) return err(ErrorCodes.NotFound,404);
  if (found.manage_token !== token) return err(ErrorCodes.Forbidden,403);
      await env.DB.prepare(`UPDATE alerts_watch SET suppressed_until=datetime('now', ? || ' minutes') WHERE id=?`).bind(minutes.toString(), id).run();
      await audit(env, { actor_type:'public', action:'snooze', resource:'alert', resource_id:id, details:{ minutes } });
      return json({ ok:true, id, suppressed_for_minutes: minutes });
    });
}

registerAlertRoutes();
