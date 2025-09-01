// Pluggable signals engine interface.
// Goal: allow swapping proprietary model without touching callers.
import type { Env } from '../lib/types';

export interface SignalComputeOptions { limit?: number }
export interface SignalComputeResult { idsProcessed: number; wroteSignals: number; provider: string }

export interface SignalsProvider {
  name: string;
  compute(env: Env, opts?: SignalComputeOptions): Promise<SignalComputeResult>;
}

// Registry (simple singleton). Could expand to dynamic selection via env.
let activeProvider: SignalsProvider | null = null;
export function setSignalsProvider(p: SignalsProvider) { activeProvider = p; }
export function getSignalsProvider(): SignalsProvider { if (!activeProvider) throw new Error('signals provider not set'); return activeProvider; }

export async function computeAndStoreSignals(env: Env, opts?: SignalComputeOptions) {
  const provider = getSignalsProvider();
  return provider.compute(env, opts);
}
