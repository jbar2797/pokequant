"use client";
import React, { useState } from 'react';
import { cn } from '../utils';

export const AppShell: React.FC<{ children: React.ReactNode; sidebar?: React.ReactNode; header?: React.ReactNode; className?: string; }>=({ children, sidebar, header, className })=>{
  const [open,setOpen]=useState(true);
  return (
    <div className={cn('min-h-screen flex flex-col', className)}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 left-2 bg-fg text-bg px-3 py-1 rounded">Skip to content</a>
      <header className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b border-border bg-card/90 px-4 backdrop-blur">
        <button aria-label="Toggle navigation" className="rounded px-2 py-1 text-sm" onClick={()=>setOpen(o=>!o)}>
          ☰
        </button>
        {header}
      </header>
      <div className="flex flex-1">
        {sidebar && (
          <nav aria-label="Primary" className={cn('transition-all duration-med border-r border-border bg-card p-3 w-56', !open && 'w-0 overflow-hidden p-0 border-r-0')}>
            {sidebar}
          </nav>) }
        <main id="main" className="flex-1 p-4">
          {children}
        </main>
      </div>
    </div>
  );
};