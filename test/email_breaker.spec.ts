import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

// Minimal circuit breaker exercise for email provider: force failures to open breaker, then confirm blocked.
// Uses provider in real mode simulation by setting headers/environment via test bootstrap if needed.

async function send(to: string){
  const r = await SELF.fetch('https://example.com/admin/diagnostic/send-test-email', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ to }) });
  return r;
}

describe('Email breaker', () => {
  it('opens after repeated forced failures (pattern fail) and blocks subsequent', async () => {
    // Force several failures using pattern 'fail' in address.
    const attempts = 6; let opened=false;
    for (let i=0;i<attempts;i++){
      const r = await send(`user${i}-fail@example.com`);
      // Accept 200/500 style statuses; route may always 200 with ok:false body.
      const j:any = await r.json().catch(()=>({}));
      if (j && j.error === 'circuit_open') { opened=true; break; }
    }
    // After loop, either opened inside, or open now.
    if (!opened) {
      const r = await send('another-fail@example.com');
      const j:any = await r.json().catch(()=>({}));
      if (j && j.error === 'circuit_open') opened=true;
    }
    expect(opened).toBe(true);
  });
});
