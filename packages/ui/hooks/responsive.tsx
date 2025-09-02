"use client";
import { useEffect, useState } from 'react';

export function useResponsiveGrid(breaks: { sm?: number; md?: number; lg?: number; xl?: number }) {
  const [cols, set] = useState(1);
  useEffect(() => {
    function compute() {
      const w = window.innerWidth;
      if (breaks.xl && w >= 1440) return set(breaks.xl);
      if (breaks.lg && w >= 1200) return set(breaks.lg);
      if (breaks.md && w >= 900) return set(breaks.md);
      if (breaks.sm && w >= 640) return set(breaks.sm);
      set(1);
    }
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [breaks]);
  return cols;
}