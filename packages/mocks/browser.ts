import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

export const worker = setupWorker(...handlers);

export async function startMocking() {
  if (typeof window === 'undefined') return;
  if ((window as any).__MSW_STARTED) return;
  await worker.start({ onUnhandledRequest: 'bypass' });
  (window as any).__MSW_STARTED = true;
}