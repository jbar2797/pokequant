import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
		coverage: {
			provider: 'v8',
			reporter: ['text','lcov'],
			thresholds: {
				lines: 60,
				functions: 60,
				branches: 50,
				statements: 60,
			},
		},
	},
});
