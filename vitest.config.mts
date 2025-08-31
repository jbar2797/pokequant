import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		testTimeout: 15000,
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
		coverage: {
			// Using Istanbul instead of V8 because V8 provider attempts to import node:inspector
			// which is unavailable in the Cloudflare workers runtime used by @cloudflare/vitest-pool-workers.
			provider: 'istanbul',
			reporter: ['text','lcov','json-summary'],
			include: ['src/**/*.ts'],
			exclude: ['src/version.ts'],
			thresholds: {
				// Ratchet baseline (2025-08-31). Auto-raise via future PRs; failing build if coverage regresses.
				lines: 66,
				functions: 59,
				branches: 46,
				statements: 59,
			},
		},
	},
});
