"use client";
import React from 'react';

export const QuickBuyLink: React.FC<{ cardId: string }> = ({ cardId }) => {
  const href = `https://partner.example.com/buy?card=${encodeURIComponent(cardId)}`;
  return <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-accent/10" aria-label="Open buy page in new tab">Buy ↗</a>;
};