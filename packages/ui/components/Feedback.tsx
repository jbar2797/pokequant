import React from 'react';
import { cn } from '../utils';

export const Skeleton: React.FC<{ className?: string; lines?: number }> = ({ className, lines = 1 }) => (
  <div aria-hidden className={cn('animate-pulse space-y-2', className)}>
    {Array.from({ length: lines }).map((_, i) => (
      <div key={i} className="h-4 w-full rounded bg-muted/30" />
    ))}
  </div>
);

export const EmptyState: React.FC<{ title: string; description?: string; action?: React.ReactNode }> = ({ title, description, action }) => (
  <div role="status" className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border p-6 text-center">
    <h3 className="text-sm font-semibold">{title}</h3>
    {description && <p className="max-w-prose text-xs text-muted">{description}</p>}
    {action}
  </div>
);

export const InlineError: React.FC<{ message: string; id?: string }> = ({ message, id }) => (
  <p id={id} role="alert" className="text-xs font-medium text-danger">
    {message}
  </p>
);