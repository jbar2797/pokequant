"use client";
import React from 'react';
// Virtualization (optional). If library missing, component still works non-virtualized.
let useVirtualizer: any;
try { useVirtualizer = require('@tanstack/react-virtual').useVirtualizer; } catch { /* no-op */ }
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, ColumnDef, SortingState } from '@tanstack/react-table';
import { cn } from '../utils';

export function DataTable<T>({ data, columns, className, caption, virtualized = false, rowEstimate = 36, height = 400 }: { data: T[]; columns: ColumnDef<T, any>[]; className?: string; caption?: string; virtualized?: boolean; rowEstimate?: number; height?: number }) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const table = useReactTable({ data, columns, state:{ sorting }, onSortingChange:setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  const parentRef = React.useRef<HTMLTableSectionElement | null>(null);
  const rowVirtualizer = (virtualized && useVirtualizer) ? useVirtualizer({
    count: table.getRowModel().rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowEstimate,
    overscan: 8
  }) : null;

  const rows = table.getRowModel().rows;
  return (
    <div className={cn('overflow-x-auto rounded-md border border-border', className)}>
      <table className="min-w-full text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-muted/10 text-xs uppercase">
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map(h => (
                <th scope="col" key={h.id} className="px-2 py-1 font-medium select-none">
                  {h.isPlaceholder? null : (
                    <button
                      type="button"
                      className="flex items-center gap-1"
                      onClick={h.column.getToggleSortingHandler()}
                      aria-label={h.column.getIsSorted() ? `Sort ${String(h.column.id)} ${h.column.getIsSorted()==='asc'?'descending':'remove sort'}` : `Sort ${String(h.column.id)} ascending`}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {h.column.getIsSorted()==='asc' && '↑'}
                      {h.column.getIsSorted()==='desc' && '↓'}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
  <tbody ref={virtualized ? parentRef : undefined} style={virtualized ? { display: 'block', maxHeight: height, overflowY: 'auto', position: 'relative' } : undefined}>
          {virtualized && rowVirtualizer ? (
            <>
              <tr style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', display: 'block' }} aria-hidden />
              {rowVirtualizer.getVirtualItems().map((vi: any) => {
                const r = rows[vi.index];
                return (
                  <tr key={r.id} className="border-t border-border/60" style={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${vi.start}px)`, width: '100%' }}>
                    {r.getVisibleCells().map(c => (
                      <td key={c.id} className="px-2 py-1 align-middle">{flexRender(c.column.columnDef.cell, c.getContext())}</td>
                    ))}
                  </tr>
                );
              })}
            </>
          ) : (
            <>
              {rows.map(r => (
                <tr key={r.id} className="border-t border-border/60">
                  {r.getVisibleCells().map(c => (
                    <td key={c.id} className="px-2 py-1 align-middle">{flexRender(c.column.columnDef.cell, c.getContext())}</td>
                  ))}
                </tr>
              ))}
            </>
          )}
          {data.length===0 && !virtualized && (
            <tr><td colSpan={columns.length} className="px-2 py-4 text-center text-xs text-muted">No rows</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}