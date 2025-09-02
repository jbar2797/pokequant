"use client";
import React from 'react';
import { useAppState } from './state/store';

export function ThemeWatcher({ children }: { children: React.ReactNode }) {
  const { theme, setTheme } = useAppState();
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
  }, [theme]);
  return (
    <>
      {children}
      <button
        type="button"
        onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        className="fixed bottom-4 left-4 z-50 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium shadow-elev2 hover:bg-brand/10"
        aria-label="Toggle theme"
      >
        {theme === 'light' ? '🌙' : '☀️'}
      </button>
    </>
  );
}
