.PHONY: dev test typecheck lint format smoke deploy

dev:
	wrangler dev

deploy:
	wrangler deploy

test:
	npm run test

typecheck:
	npm run typecheck

lint:
	npm run lint

format:
	npm run format

smoke:
	BASE=$${BASE:-http://127.0.0.1:8787} scripts/smoke.sh
