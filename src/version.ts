// Central version constant (kept in sync with package.json and openapi.yaml via scripts/version-check.js)
export const APP_VERSION = '0.8.9';
// Build metadata: optionally injected by CI (e.g., GITHUB_SHA short). Not part of semver.
export const BUILD_COMMIT: string | undefined = (globalThis as any).__BUILD_COMMIT;
