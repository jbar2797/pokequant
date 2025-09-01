import type { Env } from './types';
import { log } from './log';

export interface DiscordAlertPayload {
  title: string;
  description: string;
  url?: string;
  severity?: 'info'|'warn'|'critical';
}

export async function sendDiscordAlert(env: Env, payload: DiscordAlertPayload) {
  if (!env.DISCORD_WEBHOOK_URL) {
    log('discord_stub', { title: payload.title });
    return { ok: false, stub: true };
  }
  try {
    const body = {
      username: 'PokeQuant Alerts',
      embeds: [
        {
          title: payload.title,
          description: payload.description.slice(0, 1800),
          url: payload.url,
          color: payload.severity === 'critical' ? 0xff0000 : payload.severity === 'warn' ? 0xffa500 : 0x0099ff,
          timestamp: new Date().toISOString()
        }
      ]
    };
    const resp = await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) return { ok:false, status: resp.status };
    return { ok:true };
  } catch (e:any) {
    log('discord_error', { error: String(e) });
    return { ok:false, error: String(e) };
  }
}
