"use client";
import * as ToastPrimitives from '@radix-ui/react-toast';
import React, { createContext, useContext, useState, useCallback } from 'react';

interface ToastItem { id: string; title: string; description?: string; actionLabel?: string; onAction?: () => void }
interface ToastCtx { push(t: Omit<ToastItem,'id'>): void }
const Ctx = createContext<ToastCtx | null>(null);
export const useToast = () => {
  const c = useContext(Ctx); if (!c) throw new Error('ToastProvider missing'); return c;
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem,'id'>) => setItems(i=>[...i, { id: crypto.randomUUID(), ...t }]), []);
  return (
    <Ctx.Provider value={{ push }}>
      <ToastPrimitives.Provider swipeDirection="right">
        {children}
        {items.map(i => (
          <ToastPrimitives.Root key={i.id} className="fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-1 rounded-md border border-border bg-card px-4 py-3 shadow-elev2">
            <ToastPrimitives.Title className="text-sm font-medium">{i.title}</ToastPrimitives.Title>
            {i.description && <ToastPrimitives.Description className="text-xs text-muted leading-snug">{i.description}</ToastPrimitives.Description>}
            {i.actionLabel && i.onAction && (
              <ToastPrimitives.Action asChild altText={i.actionLabel}>
                <button onClick={i.onAction} className="self-start rounded bg-brand px-2 py-1 text-[11px] font-medium text-white hover:bg-brand/90">{i.actionLabel}</button>
              </ToastPrimitives.Action>
            )}
          </ToastPrimitives.Root>
        ))}
        <ToastPrimitives.Viewport className="fixed bottom-0 right-0 flex w-96 max-w-full flex-col gap-2 p-4" />
      </ToastPrimitives.Provider>
    </Ctx.Provider>
  );
};