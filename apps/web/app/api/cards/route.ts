import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  if (process.env.NEXT_PUBLIC_API_MOCKS === '1') {
    // Under mocks, this will be intercepted by MSW; return empty to satisfy types.
    return NextResponse.json({ cards: [] });
  }
  return NextResponse.json({ error: 'Not implemented' }, { status: 501 });
}