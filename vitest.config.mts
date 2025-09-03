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
		// Exclude Playwright e2e specs from the Cloudflare workers pool (they require node built-ins like node:os).
		// They can be run separately via Playwright CLI if needed. This unblocks CI failures.
		// Also exclude UI & a11y test files; they run in dedicated jsdom configs (vitest.ui.config.ts / vitest.a11y.config.ts)
		exclude: ['e2e/**', 'packages/ui/**'],
		// Force UI/package tests to run in a jsdom environment instead of the workers runtime to provide a DOM
		// (fixes document is not defined & axe global RNG restriction in workers).
		environmentMatchGlobs: [
			['packages/ui/**', 'jsdom'],
		],
		coverage: {
			// Using Istanbul instead of V8 because V8 provider attempts to import node:inspector
			// which is unavailable in the Cloudflare workers runtime used by @cloudflare/vitest-pool-workers.
			provider: 'istanbul',
			reporter: ['text', 'lcov', 'json-summary'],
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
