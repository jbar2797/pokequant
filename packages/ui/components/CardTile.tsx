"use client";
import React from 'react';
import Image from 'next/image';
import { SignalBadge } from './SignalBadge';
import { formatPct, formatPrice, cn } from '../utils';
import { WatchlistButton } from './WatchlistButton';
import { QuickBuyLink } from './QuickBuyLink';

export interface CardTileProps {
  id: string; name: string; set: string; rarity: string; signal: 'buy'|'hold'|'sell';
  image: string; delta1d: number; delta7d: number; price: number;
  watchActive?: boolean; onWatchToggle?: (id:string)=>void;
}

export const CardTile: React.FC<CardTileProps> = ({ id, name, set, rarity, signal, image, delta1d, delta7d, price, watchActive, onWatchToggle }) => (
  <div className="group relative flex flex-col rounded-md border border-border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-brand/50" tabIndex={0}>
    <div className="relative aspect-[3/4] w-full overflow-hidden rounded-sm bg-muted/10">
      <Image src={image} alt="" fill priority={false} sizes="(max-width:768px) 50vw, 20vw" className="object-contain" />
    </div>
    <div className="mt-2 flex flex-col gap-1">
      <h3 className="line-clamp-2 text-sm font-medium" title={name}>{name}</h3>
      <p className="text-[11px] text-muted">{set} · {rarity}</p>
      <div className="flex items-center gap-2 text-[11px]">
        <span className={cn(delta1d>=0?'text-success':'text-danger')}>{formatPct(delta1d,{sign:true})} 1D</span>
        <span className={cn(delta7d>=0?'text-success':'text-danger')}>{formatPct(delta7d,{sign:true})} 7D</span>
      </div>
      <div className="flex items-center justify-between pt-1">
        <SignalBadge signal={signal} />
        <span className="text-xs font-semibold">{formatPrice(price)}</span>
      </div>
    </div>
    <div className="mt-2 flex items-center justify-between gap-2">
  <WatchlistButton cardId={id} active={watchActive} onToggle={onWatchToggle} />
      <QuickBuyLink cardId={id} />
    </div>
  </div>
);