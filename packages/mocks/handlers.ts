import { http, HttpResponse } from 'msw';
import { filterCards, cards } from './fixtures';

export const handlers = [
  http.get('/api/cards', ({ request }) => {
    const url = new URL(request.url);
    const data = filterCards({
      query: url.searchParams.get('query') || undefined,
      set: url.searchParams.get('set') || undefined,
      rarity: url.searchParams.get('rarity') || undefined,
      signal: url.searchParams.get('signal') || undefined
    });
    return HttpResponse.json({ cards: data });
  }),
  http.get('/api/cards/:id', ({ params }) => {
    const card = cards.find(c => c.id === params.id);
    if (!card) return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    return HttpResponse.json({ card });
  }),
  http.get('/api/timeseries/:id', ({ params }) => {
    const seed = params.id?.length || 5;
    const now = Math.floor(Date.now()/1000);
    const points = Array.from({ length: 120 }).map((_,i)=>({
      t: now - (120-i)*86400,
      price: 50 + Math.sin(i/5)*5 + (i/seed),
      score: 60 + Math.cos(i/9)*8
    }));
    return HttpResponse.json({ points });
  })
];