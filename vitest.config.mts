import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

	export default defineWorkersConfig({
	test: {
		testTimeout: 25000,
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
		// Run tests sequentially to avoid D1 contention in CI; local dev can override with VITEST_MAX_THREADS.
		sequence: { concurrent: false },
		coverage: {
			// Using Istanbul instead of V8 because V8 provider attempts to import node:inspector
			// which is unavailable in the Cloudflare workers runtime used by @cloudflare/vitest-pool-workers.
			provider: 'istanbul',
			reporter: ['text','lcov','json-summary'],
			include: ['src/**/*.ts'],
			exclude: ['src/version.ts'],
			thresholds: {
				// Ratchet baseline updated (2025-08-31 late). Increased branch & lines after SLO tests.
				lines: 67,
				functions: 59,
				branches: 48,
				statements: 59,
			},
		},
		setupFiles: ['test/setup.fast.ts'],
	},
});
