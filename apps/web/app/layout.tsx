import '../globals.css';
import type { ReactNode } from 'react';
import { QueryProvider, ToastProvider, SkipLink } from '../../../packages/ui';
// ThemeWatcher is a client component that applies and toggles theme
import { ThemeWatcher } from './ThemeWatcher';
import React from 'react';
import { AppStateProvider } from './state/store';

export const metadata = { title: 'PokeQuant', description: 'Pokémon TCG Investment Analytics' };

async function initMocks() {
  if (process.env.NEXT_PUBLIC_API_MOCKS === '1' && typeof window !== 'undefined') {
    const { startMocking } = await import('../../../packages/mocks/browser');
    await startMocking();
  }
}

// (ThemeWatcher moved to its own client file)

export default function RootLayout({ children }: { children: ReactNode }) {
  if (typeof window !== 'undefined') {
    // Fire and forget
    initMocks();
  }
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
          <QueryProvider>
            <AppStateProvider>
              <ToastProvider>
                <SkipLink />
                <ThemeWatcher>
                  <div id="main" role="main" className="min-h-screen bg-bg text-fg focus:outline-none focus:ring-2 focus:ring-brand/50">
                    {children}
                    <div aria-live="polite" aria-atomic="true" className="sr-only" id="route-announcer" />
                  </div>
                </ThemeWatcher>
              </ToastProvider>
            </AppStateProvider>
          </QueryProvider>
      </body>
    </html>
  );
}
