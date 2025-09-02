"use client";
export default function CardError({ error, reset }: { error: Error; reset: () => void }) {
  return <div className="p-6 space-y-3">
    <p className="text-sm font-semibold">Failed to load card.</p>
    <p className="text-xs text-muted">{error.message}</p>
    <button onClick={reset} className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-brand/10">Retry</button>
  </div>;
}