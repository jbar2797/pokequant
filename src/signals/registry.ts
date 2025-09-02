// Static registry for signals providers (avoids dynamic import bundler warnings).
// Extend by importing provider modules here and registering them.
import { DefaultSignalsProvider } from './default_provider';
import type { SignalsProvider } from './index';

const REGISTRY: Record<string, SignalsProvider> = Object.create(null);

function add(p: SignalsProvider, aliases: string[] = []) {
  REGISTRY[p.name.toLowerCase()] = p;
  for (const a of aliases) REGISTRY[a.toLowerCase()] = p;
}

// Built-ins
add(DefaultSignalsProvider, ['default_v1']);

export function getProviderFromRegistry(name?: string | null): SignalsProvider {
  if (!name) return DefaultSignalsProvider;
  const key = name.toLowerCase();
  return REGISTRY[key] || DefaultSignalsProvider;
}

export function registerProvider(p: SignalsProvider, aliases: string[] = []) { add(p, aliases); }

// Debug / introspection (not documented) – allows tests or admin endpoints to inspect.
export function listRegisteredProviders() { return Object.keys(REGISTRY).sort(); }

export { REGISTRY as __REGISTRY_INTERNAL };
