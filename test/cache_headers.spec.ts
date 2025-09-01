import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Cache headers', () => {
  it('sets Cache-Control on universe', async () => {
    // Pre-flight health to force table creation & seed; mitigates rare worker storage rotation.
    await SELF.fetch('https://example.com/health');
    let attempt = 0;
    let lastErr: any;
    while (attempt < 2) { // simple retry to dodge transient worker "Network connection lost" crash
      try {
        const r = await SELF.fetch('https://example.com/api/universe');
        expect(r.status).toBe(200);
        const cc = r.headers.get('cache-control') || '';
        expect(cc).toContain('max-age=');
        return; // success
      } catch (e:any) {
        lastErr = e;
        if (String(e).includes('Network connection lost') || String(e).includes('disconnected')) {
          attempt++;
          continue; // retry once
        }
        throw e; // other errors should surface
      }
    }
    // If we get here both attempts failed with network error
    throw lastErr;
  });
});
