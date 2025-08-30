export function isoDaysAgo(days: number) {
	const d = new Date(Date.now() - Math.max(0, days)*86400000);
	return d.toISOString().slice(0,10);
}
