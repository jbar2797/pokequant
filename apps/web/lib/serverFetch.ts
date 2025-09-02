export function apiUrl(path: string) {
  if (path.startsWith('http')) return path;
  const base = process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL?.startsWith('http') ? process.env.VERCEL_URL : `http://localhost:${process.env.PORT||3000}`;
  return `${base}${path.startsWith('/')?path:`/${path}`}`;
}