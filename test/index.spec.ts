import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Root endpoint', () => {
	it('returns running message', async () => {
		const response = await SELF.fetch('https://example.com/');
		const body = await response.text();
		expect(body).toContain('PokeQuant API is running');
	});
});
