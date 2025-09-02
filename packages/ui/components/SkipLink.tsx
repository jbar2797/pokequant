"use client";
import React from 'react';
import { cn } from '../utils';

export const SkipLink: React.FC<{ href?: string }> = ({ href = '#main' }) => (
  <a
    href={href}
    className={cn(
      'sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[1000] focus:rounded-md focus:bg-brand focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white shadow-elev2'
    )}
  >Skip to main content</a>
);