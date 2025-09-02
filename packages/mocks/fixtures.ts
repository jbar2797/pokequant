export interface CardRecord {
  id: string;
  name: string;
  set: string;
  rarity: string;
  signal: 'buy' | 'hold' | 'sell';
  price: number;
  delta1d: number; // pct change
  delta7d: number; // pct change
  image: string;
}

// Deterministic sample data including multiple Mew variants
export const cards: CardRecord[] = [
  { id: 'mew-001', name: 'Mew (Holo)', set: 'Base Set', rarity: 'Rare Holo', signal: 'buy', price: 124.5, delta1d: 0.032, delta7d: 0.11, image: '/placeholder-card.svg' },
  { id: 'mew-002', name: 'Mew (Alt Art)', set: 'Fusion Strike', rarity: 'Secret Rare', signal: 'hold', price: 210.0, delta1d: -0.01, delta7d: 0.04, image: '/placeholder-card.svg' },
  { id: 'mew-003', name: 'Mew (EX)', set: 'Legend Maker', rarity: 'Ultra Rare', signal: 'sell', price: 98.25, delta1d: -0.045, delta7d: -0.12, image: '/placeholder-card.svg' },
  { id: 'charizard-001', name: 'Charizard', set: 'Base Set', rarity: 'Rare Holo', signal: 'buy', price: 1500, delta1d: 0.005, delta7d: 0.02, image: '/placeholder-card.svg' }
];

export function filterCards(params: { query?: string; set?: string; rarity?: string; signal?: string }) {
  const { query, set, rarity, signal } = params;
  return cards.filter(c =>
    (!query || c.name.toLowerCase().includes(query.toLowerCase())) &&
    (!set || c.set === set) &&
    (!rarity || c.rarity === rarity) &&
    (!signal || c.signal === signal)
  );
}